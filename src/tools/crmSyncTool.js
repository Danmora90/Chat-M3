import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "../services/supabase.js";
import { automationService } from "../services/automationService.js";

export const crmSyncTool = tool(
    async ({ funnel_stage, next_action, observaciones }, config) => {
        try {
            const threadId = config.configurable?.thread_id;
            if (!threadId) return "Error: No se pudo identificar la sesión actual.";
            const chatId = threadId.replace('conversation_', '');

            // Actualizar tabla chats
            const chatPayload = { updated_at: new Date().toISOString() };
            if (funnel_stage) chatPayload.funnel_stage = funnel_stage;

            await supabaseAdmin
                .from('chats')
                .update(chatPayload)
                .eq('id', chatId);

            // Disparar flujos asociados al nuevo estado del embudo
            if (funnel_stage) {
                automationService.triggerFlowForStage(chatId, funnel_stage);
            }

            // Actualizar o crear proyecto asociado
            const { data: existingProject } = await supabaseAdmin
                .from('projects')
                .select('id')
                .eq('chat_id', chatId)
                .maybeSingle();

            const projectPayload = {
                chat_id: chatId,
                updated_at: new Date().toISOString()
            };
            if (funnel_stage) projectPayload.estatus_embudo = funnel_stage;
            if (next_action) {
                projectPayload.next_action = next_action;
                projectPayload.fecha_next_action = new Date().toISOString();
            }
            if (observaciones) projectPayload.observaciones = observaciones;

            if (existingProject?.id) {
                await supabaseAdmin.from('projects').update(projectPayload).eq('id', existingProject.id);
            } else {
                await supabaseAdmin.from('projects').insert(projectPayload);
            }

            return `✅ CRM actualizado correctamente. Etapa del embudo: "${funnel_stage || 'Sin cambios'}". Próxima acción: "${next_action || 'Sin cambios'}".`;
        } catch (error) {
            return `Error al sincronizar CRM: ${error.message}`;
        }
    },
    {
        name: "crm_sync_updater",
        description: "Úsala para actualizar la etapa del embudo comercial del cliente (1 - Lead, 2 - Contactado, 3 - Interesado, 4 - Cita Agendada, 5 - Cotizado, 6 - En Negociación, 7 - Ganado) y registrar la próxima acción a realizar o notas de seguimiento.",
        schema: z.object({
            funnel_stage: z.enum([
                '1 - No tiene presupuesto',
                '2 - Credito negado',
                '3 - Le entregan lejos',
                '4 - Escribió',
                '5 - Pidio info',
                '6 - Lead',
                '7 - No asistio',
                '8 - Agendado',
                '9 - Cotizado',
                '10 - Cliente',
                '11 - Perdido',
                '12 - No agendo'
            ]).optional().describe("La nueva etapa del cliente en el embudo CRM."),
            next_action: z.string().optional().describe("Descripción de la siguiente acción a realizar (ej: 'Enviar propuesta detallada', 'Llamada de seguimiento el viernes')."),
            observaciones: z.string().optional().describe("Notas relevantes sobre las necesidades o presupuesto del cliente.")
        })
    }
);
