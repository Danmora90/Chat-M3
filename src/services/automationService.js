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

/**
 * Resuelve variables dinámicas y estáticas para plantillas de WhatsApp
 * @param {Object} rawVariables - Mapeo configurado en el paso (ej: { '1': '{{nombre}}', '2': 'https://...' })
 * @param {Object} chat - Objeto chat con relación a users (chat.users)
 * @param {Object} [project] - Proyecto CRM asociado (opcional)
 * @returns {Object} Mapeo resuelto con valores reales para Twilio (ej: { '1': 'Daniel', '2': 'https://...' })
 */
function resolveTemplateVariables(rawVariables = {}, chat = {}, project = null) {
    const resolved = {};
    const user = chat.users || {};

    // 1. Extraer nombre del cliente con fallback neutral acordado
    let customerName = (user.display_name || '').trim();
    if (!customerName || customerName.toLowerCase().includes('whatsapp user') || customerName.toLowerCase().includes('cliente whatsapp')) {
        customerName = 'Cliente';
    }

    // 2. Extraer teléfono
    const customerPhone = user.phone_number || chat.customer_phone || '';

    // 3. Extraer fecha actual en Colombia (GMT-5)
    let fechaActual = '';
    try {
        const formatter = new Intl.DateTimeFormat('es-CO', {
            timeZone: 'America/Bogota',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        fechaActual = formatter.format(new Date());
    } catch (_) {
        fechaActual = new Date().toLocaleDateString('es-CO');
    }

    // 4. Extraer link de reunión / agendamiento
    let meetLink = project?.meet_link || project?.meeting_link || '';
    if (!meetLink && process.env.CALENDAR_BOOKING_URL) {
        meetLink = process.env.CALENDAR_BOOKING_URL;
    }

    // Fecha de cita / próxima acción
    let fechaCita = '';
    if (project?.fecha_next_action) {
        try {
            const dateObj = new Date(project.fecha_next_action);
            if (!isNaN(dateObj.getTime())) {
                const citaFormatter = new Intl.DateTimeFormat('es-CO', {
                    timeZone: 'America/Bogota',
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                });
                fechaCita = citaFormatter.format(dateObj);
            }
        } catch (_) {
            fechaCita = project.fecha_next_action;
        }
    }
    if (!fechaCita) {
        fechaCita = 'los próximos días';
    }

    // Cotización / Inversión estimada
    let cotizacion = '';
    if (project?.valor_cotizado_min && project?.valor_cotizado_max) {
        cotizacion = `$${Number(project.valor_cotizado_min).toLocaleString('es-CO')} - $${Number(project.valor_cotizado_max).toLocaleString('es-CO')} COP`;
    } else if (project?.budget_total) {
        cotizacion = `$${Number(project.budget_total).toLocaleString('es-CO')} COP`;
    } else {
        cotizacion = 'según alcance y m²';
    }

    const valorRemodelacion = cotizacion;
    const etapa = chat.funnel_stage || project?.estatus_embudo || 'Lead';

    // 5. Procesar cada variable configurada
    for (const [key, rawVal] of Object.entries(rawVariables)) {
        if (rawVal === undefined || rawVal === null) continue;
        const valStr = String(rawVal).trim();
        const lowerVal = valStr.toLowerCase().replace(/[\{\}]/g, '').trim();

        if (lowerVal === 'nombre' || lowerVal === 'customer_name' || lowerVal === 'name' || lowerVal === 'cliente') {
            resolved[key] = customerName;
        } else if (lowerVal === 'telefono' || lowerVal === 'customer_phone' || lowerVal === 'phone' || lowerVal === 'celular') {
            resolved[key] = customerPhone;
        } else if (lowerVal === 'fecha' || lowerVal === 'fecha_actual' || lowerVal === 'date' || lowerVal === 'hoy') {
            resolved[key] = fechaActual;
        } else if (lowerVal === 'link_reunion' || lowerVal === 'link_agendamiento' || lowerVal === 'link' || lowerVal === 'reunion' || lowerVal === 'agendamiento') {
            resolved[key] = meetLink || 'nuestro canal de atención';
        } else if (lowerVal === 'fecha_cita' || lowerVal === 'cita' || lowerVal === 'hora_cita') {
            resolved[key] = fechaCita;
        } else if (lowerVal === 'cotizacion' || lowerVal === 'cotización' || lowerVal === 'presupuesto') {
            resolved[key] = cotizacion;
        } else if (lowerVal === 'valor_remodelacion' || lowerVal === 'valor_remodelación' || lowerVal === 'inversion' || lowerVal === 'inversión') {
            resolved[key] = valorRemodelacion;
        } else if (lowerVal === 'etapa' || lowerVal === 'funnel_stage') {
            resolved[key] = etapa;
        } else {
            // Reemplazo en línea de etiquetas embebidas
            let replaced = valStr
                .replace(/\{\{\s*(nombre|customer_name|name|cliente)\s*\}\}/gi, customerName)
                .replace(/\{\{\s*(telefono|customer_phone|phone|celular)\s*\}\}/gi, customerPhone)
                .replace(/\{\{\s*(fecha|fecha_actual|date|hoy)\s*\}\}/gi, fechaActual)
                .replace(/\{\{\s*(link_reunion|link_agendamiento|link|reunion|agendamiento)\s*\}\}/gi, meetLink || 'nuestro canal')
                .replace(/\{\{\s*(fecha_cita|cita)\s*\}\}/gi, fechaCita)
                .replace(/\{\{\s*(cotizacion|cotización|presupuesto)\s*\}\}/gi, cotizacion)
                .replace(/\{\{\s*(valor_remodelacion|valor_remodelación|inversion|inversión)\s*\}\}/gi, valorRemodelacion)
                .replace(/\{\{\s*(etapa|funnel_stage)\s*\}\}/gi, etapa);

            resolved[key] = replaced.trim();
        }

        // Seguridad: Twilio y Meta no permiten valores vacíos ""
        if (!resolved[key]) {
            resolved[key] = (key === '1') ? customerName : '-';
        }
    }

    // Fallback de seguridad: Si la variable "1" no fue configurada explícitamente, por convención de WhatsApp toma el nombre
    if (!resolved['1']) {
        resolved['1'] = customerName;
    }

    return resolved;
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

                const flowCreatedAt = new Date(flow.created_at).getTime();

                // Verificar si el chat tiene actividad posterior a la creación del flujo
                const { data: latestChatMsg } = await supabaseAdmin
                    .from('messages')
                    .select('created_at')
                    .eq('chat_id', chatId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (latestChatMsg && new Date(latestChatMsg.created_at).getTime() < flowCreatedAt) {
                    logger.info('Automations: Skipping stage flow because chat activity is older than flow creation', {
                        chatId,
                        flowId: flow.id,
                        flowCreatedAt: flow.created_at,
                        lastMsgCreatedAt: latestChatMsg.created_at
                    });
                    continue;
                }

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
                .select('id, user_id, channel, status, is_ai_paused, last_message_at, updated_at, users(phone_number)')
                .eq('status', 'active')
                .or('is_ai_paused.is.null,is_ai_paused.eq.false');

            if (chatsErr || !activeChats || activeChats.length === 0) return;

            const now = Date.now();

            for (const flow of flows) {
                const flowCreatedAt = new Date(flow.created_at).getTime();
                const inactivityMinutes = parseInt(flow.inactivity_minutes || '5', 10);
                const inactivityMs = inactivityMinutes * 60 * 1000;
                const steps = Array.isArray(flow.steps) ? flow.steps : [];
                if (steps.length === 0) continue;

                for (const chat of activeChats) {
                    // Validar canal WhatsApp y existencia de número de teléfono
                    if (chat.channel && !chat.channel.toLowerCase().startsWith('whatsapp')) continue;
                    if (!chat.users?.phone_number) continue;

                    // Consultar los mensajes recientes del chat
                    const { data: messages } = await supabaseAdmin
                        .from('messages')
                        .select('id, role, content, metadata, created_at')
                        .eq('chat_id', chat.id)
                        .order('created_at', { ascending: false })
                        .limit(5);

                    if (!messages || messages.length === 0) continue;

                    const latestMsg = messages[0];
                    const lastMsgTime = new Date(latestMsg.created_at).getTime();

                    // CONDICIÓN CRÍTICA: Piso temporal contra la fecha de creación del flujo.
                    // Si el último mensaje es anterior a la creación del flujo, se descarta por completo
                    // para evitar disparar plantillas a conversaciones históricas o cerradas.
                    if (lastMsgTime < flowCreatedAt) {
                        continue;
                    }

                    // Condición 1: El último mensaje debe ser del asistente (esperando respuesta del usuario)
                    if (latestMsg.role !== 'assistant') continue;

                    // Condición 2: Si el último mensaje del asistente ya fue un seguimiento de este flujo, no repetir
                    if (latestMsg.metadata?.is_automation && latestMsg.metadata?.flow_id === flow.id) {
                        continue;
                    }

                    // Condición 3: Verificar si ya existe alguna tarea (en cola, ejecutada, fallida o cancelada)
                    // generada para este chat y flujo en este turno de conversación (>= latestMsg.created_at) o pendiente
                    const { data: existingTasks } = await supabaseAdmin
                        .from('automation_queue')
                        .select('id')
                        .eq('chat_id', chat.id)
                        .eq('flow_id', flow.id)
                        .or(`status.eq.pending,created_at.gte.${latestMsg.created_at}`)
                        .limit(1);

                    if (existingTasks && existingTasks.length > 0) continue;

                    // Condición 4: Tiempo transcurrido de inactividad
                    if (now - lastMsgTime < inactivityMs) continue;

                    // Condición 5 (Ventana de seguridad): Si es una inactividad corta (<= 2 horas) y ya pasaron más de 24h,
                    // no enviar plantilla fuera de contexto
                    if (inactivityMinutes <= 120 && (now - lastMsgTime) > 24 * 60 * 60 * 1000) {
                        continue;
                    }

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
                        flowName: flow.name,
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

                    // Cancelar tareas si el canal no es WhatsApp
                    if (chat.channel && !chat.channel.toLowerCase().startsWith('whatsapp')) {
                        await supabaseAdmin
                            .from('automation_queue')
                            .update({
                                status: 'cancelled',
                                result_details: { reason: `Channel ${chat.channel} is not supported for WhatsApp automations` },
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', task.id);
                        continue;
                    }

                    // Validar piso temporal: Si el chat no tiene mensajes posteriores a la creación del flujo, cancelar la tarea
                    const flowCreatedAt = new Date(flow.created_at).getTime();
                    const { data: latestMsgInChat } = await supabaseAdmin
                        .from('messages')
                        .select('created_at')
                        .eq('chat_id', chat.id)
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (latestMsgInChat && new Date(latestMsgInChat.created_at).getTime() < flowCreatedAt) {
                        await supabaseAdmin
                            .from('automation_queue')
                            .update({
                                status: 'cancelled',
                                result_details: { reason: 'Chat activity is older than flow creation date' },
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', task.id);
                        logger.info('Automations: Cancelled pending task because chat activity is prior to flow creation', {
                            taskId: task.id,
                            chatId: chat.id
                        });
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

                        // Consultar datos del proyecto CRM si existe para variables de cotización y agenda
                        const { data: project } = await supabaseAdmin
                            .from('projects')
                            .select('*')
                            .eq('chat_id', chat.id)
                            .maybeSingle();

                        // Resolver variables dinámicas y estáticas personalizadas para este usuario/chat
                        const rawVariables = payload.variables || {};
                        const filledVariables = resolveTemplateVariables(rawVariables, chat, project);

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
