import { getAgent } from '../agent/graph.js';
import { supabaseAdmin, saveMessage } from './supabase.js';
import { sendWhatsAppMessage } from './twilio.js';
import { generateThreadId } from '../utils/session.js';
import { logger } from '../middleware/logger.js';

// Rango configurable en segundos (por defecto entre 60s y 300s = 1 a 5 minutos)
const MIN_DELAY_SECONDS = parseInt(process.env.MIN_RESPONSE_DELAY_SEC || '60', 10);
const MAX_DELAY_SECONDS = parseInt(process.env.MAX_RESPONSE_DELAY_SEC || '300', 10);

/**
 * Mapa de respuestas pendientes en memoria: chatId -> Objeto de tarea
 * {
 *   timeoutId,
 *   scheduledAt: timestamp,
 *   fireAt: timestamp,
 *   messages: [string],
 *   userPhone: string,
 *   userId: string
 * }
 */
const pendingResponses = new Map();

/**
 * Calcula un tiempo de espera aleatorio en milisegundos entre MIN y MAX
 */
function calculateRandomDelayMs() {
    const min = Math.max(1, MIN_DELAY_SECONDS);
    const max = Math.max(min, MAX_DELAY_SECONDS);
    const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
    return seconds * 1000;
}

export const delayedResponseService = {
    /**
     * Programa o acumula la respuesta de la IA con un intervalo aleatorio humano
     * @param {Object} params
     * @param {string} params.chatId - ID del chat
     * @param {string} params.userPhone - Teléfono del cliente
     * @param {string} params.userId - ID del usuario en Supabase
     * @param {string} params.messageContent - Contenido del mensaje recibido
     */
    scheduleResponse({ chatId, userPhone, userId, messageContent }) {
        if (!chatId || !messageContent) return;

        // Si ya hay un temporizador activo para este chat, acumulamos el mensaje (debouncing/buffering)
        if (pendingResponses.has(chatId)) {
            const currentTask = pendingResponses.get(chatId);
            currentTask.messages.push(messageContent);
            const remainingSeconds = Math.max(0, Math.round((currentTask.fireAt - Date.now()) / 1000));

            logger.info('DelayedResponse: Buffered additional message from user during wait interval', {
                chatId,
                totalBuffered: currentTask.messages.length,
                remainingSeconds
            });
            return;
        }

        // Generar retardo aleatorio entre 1 y 5 minutos
        const delayMs = calculateRandomDelayMs();
        const delaySeconds = Math.round(delayMs / 1000);
        const now = Date.now();

        logger.info('DelayedResponse: Scheduled humanized response interval', {
            chatId,
            userPhone,
            delaySeconds,
            delayMinutes: (delaySeconds / 60).toFixed(1)
        });

        const timeoutId = setTimeout(async () => {
            await delayedResponseService.executeDelayedResponse(chatId);
        }, delayMs);

        pendingResponses.set(chatId, {
            timeoutId,
            scheduledAt: now,
            fireAt: now + delayMs,
            messages: [messageContent],
            userPhone,
            userId
        });
    },

    /**
     * Ejecuta el turno del agente tras cumplirse el intervalo de tiempo aleatorio
     * @param {string} chatId
     */
    async executeDelayedResponse(chatId) {
        const task = pendingResponses.get(chatId);
        if (!task) return;

        // Limpiar del mapa antes de procesar
        pendingResponses.delete(chatId);

        try {
            // 1. Verificar si la IA fue pausada durante el tiempo de espera (intervención humana)
            const { data: chat, error: chatErr } = await supabaseAdmin
                .from('chats')
                .select('id, is_ai_paused')
                .eq('id', chatId)
                .maybeSingle();

            if (chatErr || !chat) {
                logger.warn('DelayedResponse: Chat not found on timer execution', { chatId });
                return;
            }

            if (chat.is_ai_paused) {
                logger.info('DelayedResponse: Cancelled response because AI was paused (human handoff active)', { chatId });
                return;
            }

            // 2. Verificar si un asesor humano envió un mensaje manual durante la espera
            const { data: recentHumanMsg } = await supabaseAdmin
                .from('messages')
                .select('id, created_at, metadata')
                .eq('chat_id', chatId)
                .eq('role', 'assistant')
                .gt('created_at', new Date(task.scheduledAt).toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (recentHumanMsg && (recentHumanMsg.metadata?.manual || recentHumanMsg.metadata?.is_human)) {
                logger.info('DelayedResponse: Cancelled response because human advisor replied manually during wait interval', {
                    chatId,
                    recentMessageId: recentHumanMsg.id
                });
                return;
            }

            // 3. Agrupar todos los mensajes que el cliente envió durante la espera
            const combinedMessage = task.messages.join('\n');

            logger.info('DelayedResponse: Invoking agent with aggregated thoughts', {
                chatId,
                messagesCount: task.messages.length,
                combinedPreview: combinedMessage.slice(0, 100)
            });

            // 4. Invocar al agente en LangGraph
            const agent = await getAgent();
            const threadId = generateThreadId(chatId);
            const config = {
                configurable: {
                    thread_id: threadId
                }
            };

            const result = await agent.invoke(
                {
                    messages: [{ role: 'user', content: combinedMessage }],
                    userPhone: task.userPhone,
                    chatId,
                    userId: task.userId
                },
                config
            );

            // 5. Extraer y enviar la respuesta por WhatsApp
            const lastMessage = result.messages[result.messages.length - 1];
            const responseText = lastMessage?.content || '';

            if (!responseText) {
                logger.warn('DelayedResponse: Empty response generated by agent', { chatId });
                return;
            }

            const twilioResponse = await sendWhatsAppMessage(task.userPhone, responseText);

            logger.info('DelayedResponse: Human-like delayed response successfully delivered to WhatsApp', {
                chatId,
                to: task.userPhone,
                twilioSid: twilioResponse.sid
            });

            // 6. Guardar en base de datos con metadata de retardo
            await saveMessage(
                chatId,
                task.userId,
                'assistant',
                responseText,
                {
                    delayed_response: true,
                    aggregated_messages_count: task.messages.length
                },
                twilioResponse.sid
            );

        } catch (error) {
            logger.error('DelayedResponse: Error processing delayed response', {
                chatId,
                error: error.message,
                stack: error.stack
            });
        }
    },

    /**
     * Cancela cualquier respuesta programada para un chat (usado cuando un asesor humano interviene)
     * @param {string} chatId
     */
    cancelPendingResponse(chatId) {
        if (!chatId) return;
        if (pendingResponses.has(chatId)) {
            const task = pendingResponses.get(chatId);
            clearTimeout(task.timeoutId);
            pendingResponses.delete(chatId);
            logger.info('DelayedResponse: Cancelled pending response timer', { chatId });
        }
    },

    /**
     * Verifica si hay una respuesta programada pendiente para un chat
     * @param {string} chatId
     * @returns {boolean}
     */
    hasPendingResponse(chatId) {
        return pendingResponses.has(chatId);
    }
};
