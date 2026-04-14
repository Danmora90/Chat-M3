import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "../services/supabase.js";

export const updateChatTagTool = tool(
    async ({ tag }, config) => {
        try {
            const threadId = config.configurable?.thread_id;
            if (!threadId) return "Error: No se pudo identificar la sesión.";
            const chatId = threadId.replace('conversation_', '');

            // 1. Traer metadata actual para no borrar la campanita u otros datos
            const { data: chat } = await supabaseAdmin
                .from('chats')
                .select('metadata')
                .eq('id', chatId)
                .single();

            const currentMetadata = chat?.metadata || {};

            // 2. Actualizar solo el tag
            await supabaseAdmin
                .from('chats')
                .update({ metadata: { ...currentMetadata, current_tag: tag } })
                .eq('id', chatId);

            return `✅ Etiqueta del chat actualizada exitosamente a: ${tag}.`;
        } catch (error) {
            return `Error al actualizar etiqueta: ${error.message}`;
        }
    },
    {
        name: "update_chat_tag",
        description: "Actualiza la etiqueta de estado de la conversación actual. Úsala SOLO cuando detectes una intención clara del usuario: interes en diseño/estilos (tag: 'diseño'), pidió calcular áreas/presupuestos (tag: 'cotización'), consulta sobre calidad/marcas (tag: 'dudas_materiales'), el presupuesto no alcanza (tag: 'viabilidad_negativa'), o si envió el pago (tag: 'adelanto_pagado').",
        schema: z.object({
            tag: z.enum(['diseño', 'cotización', 'dudas_materiales', 'viabilidad_negativa', 'adelanto_pagado', 'normal']).describe("La etiqueta a aplicar según la intención del cliente.")
        })
    }
);
