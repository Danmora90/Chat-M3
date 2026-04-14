import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { salesService } from "../services/salesService.js";
import { supabaseAdmin } from "../services/supabase.js";
import { logger } from "../middleware/logger.js";

export const processPaymentTool = tool(
    async ({ amount_detected, payment_method, account_number_detected, evidence_text }, config) => {
        try {
            console.log(">>> 🛠️ [INICIO register_sale / adelanto_obra]");

            const threadId = config.configurable?.thread_id;
            if (!threadId) return "❌ Error interno: No se puede identificar la sesión de chat.";
            const chatId = threadId.replace('conversation_', '');

            let hasImage = false;
            let rawDetection = [account_number_detected, evidence_text].join(" ");

            try {
                const { data: recentMsgs } = await supabaseAdmin
                    .from('messages')
                    .select('metadata')
                    .eq('chat_id', chatId)
                    .eq('role', 'user')
                    .order('created_at', { ascending: false })
                    .limit(3);

                if (recentMsgs) {
                    for (const msg of recentMsgs) {
                        const isImageOrAttachment = msg.metadata?.image_analysis || (msg.metadata?.attachments && msg.metadata.attachments.length > 0);
                        if (isImageOrAttachment) {
                            hasImage = true;
                            if (msg.metadata?.image_analysis?.text_content) {
                                rawDetection += " " + msg.metadata.image_analysis.text_content;
                            }
                            break;
                        }
                    }
                }
            } catch (dbErr) {
                logger.warn(">>> [OCR] Fallo al intentar bypass de BD", dbErr);
            }

            if (!hasImage) {
                return "❌ BLOQUEO DE SISTEMA: El usuario NO ha enviado ninguna foto o captura de comprobante de pago del adelanto. Pídele que envíe la imagen del comprobante para continuar.";
            }

            const cleanNumber = String(rawDetection).replace(/\D/g, '');
            const validAccounts = ["4589642135", "3114586947"]; // Cuentas autorizadas de Mas3
            const isValid = validAccounts.some(acc => cleanNumber.includes(acc));

            if (!isValid) {
                return `❌ Error: El número de cuenta origen/destino detectado no coincide con nuestras cuentas. Envía una foto más clara donde se vea la cuenta (4589642135 o 3114586947).`;
            }

            const recentSale = await salesService.checkRecentSales(chatId);
            if (recentSale) {
                return "⚠️ Ya registramos tu pago del adelanto hace un momento.";
            }

            // Aquí el finalAmount puede venir del LLM (lo que detectó en el recibo) o lo que se cotizó.
            const finalAmount = amount_detected ? Number(amount_detected) : 0; 

            const saleResult = await salesService.verifyAndRegisterSale(
                chatId,
                finalAmount,
                payment_method || 'transfer_confirmed_by_user'
            );

            if (saleResult.success) {
                const { data: chatData } = await supabaseAdmin
                    .from('chats')
                    .select('metadata')
                    .eq('id', chatId)
                    .single();

                const currentMetadata = chatData?.metadata || {};

                await supabaseAdmin
                    .from('chats')
                    .update({
                        metadata: { ...currentMetadata, has_new_sale: true, latest_sale_id: saleResult.saleId, current_tag: 'adelanto_pagado' }
                    })
                    .eq('id', chatId);

                const orderCode = saleResult.orderCode || saleResult.saleId.slice(0, 8);
                return `✅ ¡Pago del anticipo confirmado! (Hito #${orderCode}). Programaremos tu visita o inicio de obra en breve. Muchas gracias por confiar en Mas3.`;
            } else {
                return `❌ No pudimos registrar el adelanto: ${saleResult.message}.`;
            }

        } catch (error) {
            logger.error("❌ Error interno en register_sale:", error);
            return `Ocurrió un error técnico procesando el anticipo: ${error.message}`;
        }
    },
    {
        name: "register_payment_advance",
        description: "⚡ PELIGRO: ÚSALA EXCLUSIVAMENTE CUANDO EL USUARIO HAYA ENVIADO UNA IMAGEN DE TRANSFERENCIA POR ADELANTO DE OBRA. Registra el hito de pago.",
        schema: z.object({
            amount_detected: z.number().optional().describe("Monto verificado en la imagen del comprobante."),
            payment_method: z.string().optional().describe("Método de pago (Bancolombia, Nequi, etc)."),
            account_number_detected: z.string().optional().describe("El número de cuenta exacto de 10 dígitos (ej: 4589642135) que leíste en el comprobante."),
            evidence_text: z.string().optional().describe("Texto de soporte")
        })
    }
);

// Alias para mantener compatibilidad si el agente lo requiere
export const registerSaleTool = processPaymentTool;
