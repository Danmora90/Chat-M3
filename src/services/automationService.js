import { supabaseAdmin, saveMessage, getOrCreateUser, getOrCreateChat } from './supabase.js';
import { sendWhatsAppTemplate, sendWhatsAppMessage } from './twilio.js';
import { twilioContentService } from './twilioContentService.js';
import { updateAgentMemory } from '../agent/graph.js';
import { logger } from '../middleware/logger.js';

/**
 * Convierte un valor y unidad de tiempo a milisegundos
 */
function calculateDelayMs(value, unit = 'hours') {
    const num = Math.max(0, parseInt(value || '0', 10));
    switch (unit.toLowerCase()) {
        case 'minutes':
        case 'min':
            return num * 60 * 1000;
        case 'days':
        case 'd':
            return num * 24 * 60 * 60 * 1000;
        case 'hours':
        case 'h':
        default:
            return num * 60 * 60 * 1000;
    }
}

export const automationService = {
    /**
     * Dispara los flujos asociados a un cambio de etapa de embudo (funnel_stage)
     * @param {string} chatId
     * @param {string} stage
     */
    async triggerFlowForStage(chatId, stage) {
        if (!chatId || !stage) return;

        try {
            logger.info('Automations: Checking flows for stage change', { chatId, stage });

            // 1. Buscar flujos activos para esta etapa
            const { data: flows, error } = await supabaseAdmin
                .from('automation_flows')
                .select('*')
                .eq('trigger_type', 'stage_change')
                .eq('trigger_stage', stage)
                .eq('is_active', true);

            if (error || !flows || flows.length === 0) {
                return;
            }

            for (const flow of flows) {
                const steps = Array.isArray(flow.steps) ? flow.steps : [];
                if (steps.length === 0) continue;

                // Cancelar cualquier tarea pendiente previa de este mismo flujo para este chat
                await supabaseAdmin
                    .from('automation_queue')
                    .update({
                        status: 'cancelled',
                        result_details: { reason: 'Re-triggered by stage change' },
                        updated_at: new Date().toISOString()
                    })
                    .eq('chat_id', chatId)
                    .eq('flow_id', flow.id)
                    .eq('status', 'pending');

                // Encolar el primer paso (paso 0)
                const firstStep = steps[0];
                const delayMs = calculateDelayMs(firstStep.delay_value, firstStep.delay_unit);
                const scheduledAt = new Date(Date.now() + delayMs).toISOString();

                await supabaseAdmin
                    .from('automation_queue')
                    .insert({
                        flow_id: flow.id,
                        chat_id: chatId,
                        step_index: 0,
                        scheduled_at: scheduledAt,
                        status: 'pending',
                        condition_type: firstStep.condition || 'if_no_reply',
                        action_type: firstStep.action_type || 'send_template',
                        action_payload: firstStep
                    });

                logger.info('Automations: Enqueued first step of flow', {
                    flowId: flow.id,
                    flowName: flow.name,
                    chatId,
                    scheduledAt
                });
            }
        } catch (err) {
            logger.error('Automations: Error triggering flow for stage', { chatId, stage, error: err.message });
        }
    },

    /**
     * Cancela tareas pendientes condicionadas a "si no responde" cuando el cliente escribe
     * @param {string} chatId
     */
    async onCustomerReplied(chatId) {
        if (!chatId) return;

        try {
            const { data: cancelled, error } = await supabaseAdmin
                .from('automation_queue')
                .update({
                    status: 'cancelled',
                    result_details: { reason: 'Customer replied before scheduled time' },
                    updated_at: new Date().toISOString()
                })
                .eq('chat_id', chatId)
                .eq('status', 'pending')
                .eq('condition_type', 'if_no_reply')
                .select('id, flow_id');

            if (cancelled && cancelled.length > 0) {
                logger.info('Automations: Cancelled pending follow-up steps because customer replied', {
                    chatId,
                    cancelledCount: cancelled.length
                });
            }
        } catch (err) {
            logger.error('Automations: Error cancelling tasks on reply', { chatId, error: err.message });
        }
    },

    /**
     * Evalúa y encola flujos basados en inactividad de la conversación (reemplazo del cronjob viejo)
     */
    async checkInactivityTriggers() {
        try {
            // 1. Obtener flujos activos de inactividad
            const { data: flows, error: flowsErr } = await supabaseAdmin
                .from('automation_flows')
                .select('*')
                .eq('trigger_type', 'inactivity')
                .eq('is_active', true);

            if (flowsErr || !flows || flows.length === 0) return;

            // 2. Obtener chats activos sin IA pausada
            const { data: activeChats, error: chatsErr } = await supabaseAdmin
                .from('chats')
                .select('id, user_id, status, is_ai_paused, last_message_at, updated_at')
                .eq('status', 'active')
                .or('is_ai_paused.is.null,is_ai_paused.eq.false');

            if (chatsErr || !activeChats || activeChats.length === 0) return;

            const now = Date.now();

            for (const flow of flows) {
                const inactivityMinutes = parseInt(flow.inactivity_minutes || '5', 10);
                const inactivityMs = inactivityMinutes * 60 * 1000;
                const steps = Array.isArray(flow.steps) ? flow.steps : [];
                if (steps.length === 0) continue;

                for (const chat of activeChats) {
                    // Verificar si ya tiene una tarea pendiente de este flujo
                    const { data: pending } = await supabaseAdmin
                        .from('automation_queue')
                        .select('id')
                        .eq('chat_id', chat.id)
                        .eq('flow_id', flow.id)
                        .eq('status', 'pending')
                        .maybeSingle();

                    if (pending) continue;

                    // Consultar los últimos 2 mensajes del chat
                    const { data: messages } = await supabaseAdmin
                        .from('messages')
                        .select('id, role, content, metadata, created_at')
                        .eq('chat_id', chat.id)
                        .order('created_at', { ascending: false })
                        .limit(5);

                    if (!messages || messages.length === 0) continue;

                    const latestMsg = messages[0];

                    // Condición 1: El último mensaje debe ser del asistente
                    if (latestMsg.role !== 'assistant') continue;

                    // Condición 2: Si el último mensaje del asistente ya fue un seguimiento de este flujo, no repetir
                    if (latestMsg.metadata?.is_automation && latestMsg.metadata?.flow_id === flow.id) {
                        continue;
                    }

                    // Condición 3: Tiempo transcurrido de inactividad
                    const lastMsgTime = new Date(latestMsg.created_at).getTime();
                    if (now - lastMsgTime < inactivityMs) continue;

                    // Si cumple todo, encolar el paso 0 de inmediato (scheduled_at = now)
                    const firstStep = steps[0];
                    await supabaseAdmin
                        .from('automation_queue')
                        .insert({
                            flow_id: flow.id,
                            chat_id: chat.id,
                            step_index: 0,
                            scheduled_at: new Date().toISOString(),
                            status: 'pending',
                            condition_type: firstStep.condition || 'if_no_reply',
                            action_type: firstStep.action_type || 'send_template',
                            action_payload: firstStep
                        });

                    logger.info('Automations: Enqueued inactivity follow-up task', {
                        chatId: chat.id,
                        flowId: flow.id,
                        inactivityMinutes
                    });
                }
            }
        } catch (err) {
            logger.error('Automations: Error checking inactivity triggers', { error: err.message });
        }
    },

    /**
     * Procesa la cola de tareas vencidas (scheduled_at <= NOW() y status = 'pending')
     */
    async processQueue() {
        try {
            const nowIso = new Date().toISOString();

            // 1. Obtener tareas pendientes cuya hora de ejecución ya llegó
            const { data: tasks, error } = await supabaseAdmin
                .from('automation_queue')
                .select('*, automation_flows(*)')
                .eq('status', 'pending')
                .lte('scheduled_at', nowIso)
                .order('scheduled_at', { ascending: true })
                .limit(20);

            if (error || !tasks || tasks.length === 0) {
                return;
            }

            for (const task of tasks) {
                try {
                    // Verificar si el flujo sigue activo
                    const flow = task.automation_flows;
                    if (!flow || !flow.is_active) {
                        await supabaseAdmin
                            .from('automation_queue')
                            .update({
                                status: 'cancelled',
                                result_details: { reason: 'Flow is inactive or deleted' },
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', task.id);
                        continue;
                    }

                    // 2. Obtener datos del chat y usuario
                    const { data: chat } = await supabaseAdmin
                        .from('chats')
                        .select('*, users(*)')
                        .eq('id', task.chat_id)
                        .maybeSingle();

                    if (!chat || !chat.users?.phone_number) {
                        await supabaseAdmin
                            .from('automation_queue')
                            .update({
                                status: 'failed',
                                result_details: { reason: 'Chat or phone number not found' },
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', task.id);
                        continue;
                    }

                    // 3. Evaluar condición: si era 'if_no_reply', verificar si el usuario contestó después de encolar
                    if (task.condition_type === 'if_no_reply') {
                        const { data: userReplies } = await supabaseAdmin
                            .from('messages')
                            .select('id, created_at')
                            .eq('chat_id', chat.id)
                            .eq('role', 'user')
                            .gte('created_at', task.created_at)
                            .limit(1);

                        if (userReplies && userReplies.length > 0) {
                            await supabaseAdmin
                                .from('automation_queue')
                                .update({
                                    status: 'cancelled',
                                    result_details: { reason: 'Customer replied before execution' },
                                    updated_at: new Date().toISOString()
                                })
                                .eq('id', task.id);
                            logger.info('Automations: Task cancelled because customer already replied', { taskId: task.id, chatId: chat.id });
                            continue;
                        }
                    }

                    const payload = task.action_payload || {};
                    let executionResult = {};

                    // 4. Ejecutar la acción correspondiente
                    if (task.action_type === 'send_template') {
                        const templateSid = payload.template_sid;
                        if (!templateSid) {
                            throw new Error('No template_sid specified in action payload');
                        }

                        // Preparar variables con autocompletado de nombre si aplica
                        const rawVariables = payload.variables || {};
                        const filledVariables = { ...rawVariables };
                        if (!filledVariables['1'] && chat.users.display_name) {
                            filledVariables['1'] = chat.users.display_name;
                        }

                        const sendRes = await sendWhatsAppTemplate(
                            chat.users.phone_number,
                            templateSid,
                            filledVariables
                        );

                        // Obtener texto de la plantilla renderizado para reflejar en el chat
                        const messageBody = await twilioContentService.getRenderedTemplateBody(templateSid, filledVariables);

                        // Guardar en messages para visibilidad en tiempo real en la plataforma
                        await saveMessage(
                            chat.id,
                            chat.user_id,
                            'assistant',
                            messageBody,
                            {
                                is_automation: true,
                                flow_id: task.flow_id,
                                template_sid: templateSid,
                                step_index: task.step_index
                            },
                            sendRes.sid
                        );

                        // Sincronizar mensaje automatizado en la memoria de LangGraph
                        await updateAgentMemory(
                            chat.id,
                            {
                                role: 'assistant',
                                content: messageBody
                            },
                            {
                                userPhone: chat.users.phone_number,
                                userId: chat.user_id
                            }
                        );

                        executionResult = { sent_to: chat.users.phone_number, message_sid: sendRes.sid };
                        logger.info('Automations: Successfully sent template to customer', {
                            chatId: chat.id,
                            templateSid,
                            messageSid: sendRes.sid
                        });

                    } else if (task.action_type === 'notify_admin') {
                        // Enviar alerta por WhatsApp a los números de administradores configurados
                        const targetPhones = Array.isArray(payload.target_phones) ? payload.target_phones : [];
                        const customerName = chat.users?.display_name || 'Prospecto';
                        const customerPhone = chat.users?.phone_number || '';
                        const funnelStage = chat.funnel_stage || 'N/A';
                        const customDetail = payload.message || `Sin respuesta tras ${task.step_index === 0 ? 'inactividad' : 'seguimiento'}`;

                        const alertText = (payload.message || 'Alerta de seguimiento de cliente')
                            .replace(/\{\{customer_name\}\}/g, customerName)
                            .replace(/\{\{customer_phone\}\}/g, customerPhone)
                            .replace(/\{\{funnel_stage\}\}/g, funnelStage)
                            .replace(/\{\{flow_name\}\}/g, flow.name || '');

                        // Si se configuró una plantilla aprobada para la alerta (garantiza entrega 24/7 sin restricción de 24h)
                        const adminTemplateSid = payload.template_sid;
                        const templateVariables = {
                            "1": customerName,
                            "2": customerPhone,
                            "3": funnelStage,
                            "4": customDetail,
                            ...(payload.variables || {})
                        };

                        const notifyResults = [];
                        for (const adminPhone of targetPhones) {
                            try {
                                const cleanAdminPhone = String(adminPhone).replace(/[^\d+]/g, '');
                                if (cleanAdminPhone.length >= 8) {
                                    let adminRes;
                                    if (payload.notify_mode !== 'custom_text' && adminTemplateSid) {
                                        adminRes = await sendWhatsAppTemplate(cleanAdminPhone, adminTemplateSid, templateVariables);
                                    } else {
                                        adminRes = await sendWhatsAppMessage(cleanAdminPhone, alertText);
                                    }
                                    notifyResults.push({
                                        phone: cleanAdminPhone,
                                        sid: adminRes.sid,
                                        method: (payload.notify_mode !== 'custom_text' && adminTemplateSid) ? 'template' : 'message'
                                    });
                                }
                            } catch (admErr) {
                                notifyResults.push({ phone: adminPhone, error: admErr.message });
                            }
                        }

                        executionResult = { notified_admins: notifyResults };
                        logger.info('Automations: Sent admin notifications', {
                            chatId: chat.id,
                            templateSid: adminTemplateSid || null,
                            results: notifyResults
                        });
                    }

                    // 5. Marcar tarea como completada
                    await supabaseAdmin
                        .from('automation_queue')
                        .update({
                            status: 'completed',
                            executed_at: new Date().toISOString(),
                            result_details: executionResult,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', task.id);

                    // 6. Programar el siguiente paso en la secuencia si existe
                    const steps = Array.isArray(flow.steps) ? flow.steps : [];
                    const nextStepIndex = task.step_index + 1;

                    if (steps[nextStepIndex]) {
                        const nextStep = steps[nextStepIndex];
                        const nextDelayMs = calculateDelayMs(nextStep.delay_value, nextStep.delay_unit);
                        const nextScheduledAt = new Date(Date.now() + nextDelayMs).toISOString();

                        await supabaseAdmin
                            .from('automation_queue')
                            .insert({
                                flow_id: flow.id,
                                chat_id: chat.id,
                                step_index: nextStepIndex,
                                scheduled_at: nextScheduledAt,
                                status: 'pending',
                                condition_type: nextStep.condition || 'if_no_reply',
                                action_type: nextStep.action_type || 'send_template',
                                action_payload: nextStep
                            });

                        logger.info('Automations: Scheduled next step in chain', {
                            flowId: flow.id,
                            chatId: chat.id,
                            nextStepIndex,
                            nextScheduledAt
                        });
                    }

                } catch (taskErr) {
                    logger.error('Automations: Task execution failed', { taskId: task.id, error: taskErr.message });
                    await supabaseAdmin
                        .from('automation_queue')
                        .update({
                            status: 'failed',
                            result_details: { error: taskErr.message },
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', task.id);
                }
            }
        } catch (err) {
            logger.error('Automations: Error processing queue', { error: err.message });
        }
    }
};
