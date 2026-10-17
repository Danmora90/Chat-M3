import express from 'express';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';
import { getAgent, updateAgentMemory } from '../agent/graph.js';
import { 
    getOrCreateMetaUser, 
    getOrCreateMetaChat, 
    saveMessage,
    hasMessageSid 
} from '../services/supabase.js';
import { 
    sendMessengerMessage, 
    sendInstagramMessage, 
    replyInstagramComment, 
    replyFacebookComment 
} from '../services/metaService.js';
import { generateThreadId } from '../utils/session.js';

const router = express.Router();

/**
 * Endpoint de verificación para Meta (Facebook Messenger e Instagram)
 */
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.META_VERIFY_TOKEN || 'mas3_secret_verify_token_2026';

    if (mode === 'subscribe' && token === verifyToken) {
        logger.info('Meta webhook verified successfully');
        return res.status(200).send(challenge);
    } else {
        logger.warn('Meta webhook verification failed: Token mismatch or invalid mode', { mode });
        return res.status(403).send('Verification token mismatch');
    }
});

/**
 * Endpoint principal para recibir eventos de Meta (Facebook e Instagram)
 */
router.post('/', catchAsync(async (req, res) => {
    const body = req.body;

    // Responder 200 OK de inmediato a Meta para cumplir con el SLA de respuesta (<5s)
    res.status(200).send('EVENT_RECEIVED');

    if (!body || !body.entry) {
        return;
    }

    // Procesar los eventos de forma asíncrona en segundo plano
    processMetaEvents(body).catch(error => {
        logger.error('Error processing Meta webhook event asynchronously', {
            error: error.message,
            stack: error.stack
        });
    });
}));

/**
 * Procesa el lote de eventos recibidos de Meta
 */
async function processMetaEvents(body) {
    const storeId = process.env.STORE_ID || null;
    const isInstagramObject = body.object === 'instagram';

    for (const entry of body.entry) {
        const entryId = entry.id; // Page ID o Instagram Account ID

        // 1. Procesar Mensajes Directos (DMs)
        if (Array.isArray(entry.messaging)) {
            for (const messagingEvent of entry.messaging) {
                await handleDirectMessage(messagingEvent, isInstagramObject, storeId, entryId);
            }
        }

        // 2. Procesar Comentarios o Cambios en Feed
        if (Array.isArray(entry.changes)) {
            for (const change of entry.changes) {
                await handleChangeEvent(change, isInstagramObject, storeId, entryId);
            }
        }
    }
}

/**
 * Manejador de Mensajes Directos (Messenger o Instagram Direct)
 */
async function handleDirectMessage(event, isInstagramObject, storeId, entryId) {
    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const message = event.message;

    // Ignorar si no hay mensaje, si es un echo (enviado por la propia página) o si el remitente es la página
    if (!message || message.is_echo || senderId === entryId) {
        return;
    }

    const messageText = message.text;
    const messageMid = message.mid;

    // Por ahora procesamos mensajes de texto (o indicadores de adjunto si no hay texto)
    let contentToProcess = messageText;
    if (!contentToProcess) {
        if (message.attachments && message.attachments.length > 0) {
            contentToProcess = '[El usuario envió un archivo adjunto]';
        } else {
            return; // Nada que procesar
        }
    }

    const platform = isInstagramObject ? 'instagram' : 'facebook';

    logger.info(`Received ${platform} direct message`, {
        from: senderId,
        mid: messageMid,
        length: contentToProcess.length
    });

    try {
        // 1. Obtener o crear usuario de Meta
        const user = await getOrCreateMetaUser({
            metaId: senderId,
            platform,
            storeId
        });

        // 2. Obtener o crear chat
        const chat = await getOrCreateMetaChat(user.id, platform, storeId);

        // 3. Idempotencia: evitar procesar dos veces el mismo mid si Meta reintenta
        if (messageMid) {
            const exists = await hasMessageSid(chat.id, messageMid);
            if (exists) {
                logger.warn(`Duplicate Meta message ignored (idempotent)`, { mid: messageMid });
                return;
            }
        }

        // 4. Guardar mensaje del usuario
        await saveMessage(
            chat.id,
            user.id,
            'user',
            contentToProcess,
            { platform, meta_mid: messageMid },
            messageMid || null
        );

        // 5. Verificar si el chat está pausado por humano
        if (chat.is_ai_paused) {
            logger.info('Chat is in Human Handoff mode (AI paused). Skipping automated response.', {
                chatId: chat.id,
                platform
            });

            // Guardar el mensaje del usuario en la memoria de LangGraph para que persista al reactivar la IA
            await updateAgentMemory(
                chat.id,
                {
                    role: 'user',
                    content: contentToProcess
                },
                {
                    userId: user.id
                }
            );

            return;
        }

        // 6. Invocar al agente IA
        const agent = await getAgent();
        const threadId = generateThreadId(chat.id);
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const result = await agent.invoke(
            {
                messages: [{ role: 'user', content: contentToProcess }],
                userPhone: `${platform}:${senderId}`,
                chatId: chat.id,
                userId: user.id
            },
            config
        );

        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = lastMessage.content;

        // 7. Guardar respuesta del asistente
        await saveMessage(chat.id, user.id, 'assistant', responseText, { platform });

        // 8. Enviar respuesta a Meta
        if (platform === 'instagram') {
            await sendInstagramMessage(senderId, responseText);
        } else {
            await sendMessengerMessage(senderId, responseText);
        }

        logger.info(`${platform} message responded successfully`, { to: senderId });

    } catch (err) {
        logger.error(`Error processing ${platform} message`, {
            error: err.message,
            stack: err.stack,
            from: senderId
        });
    }
}

/**
 * Manejador de Comentarios (Reels y Publicaciones de Instagram y Facebook)
 */
async function handleChangeEvent(change, isInstagramObject, storeId, entryId) {
    const field = change.field;
    const value = change.value;

    if (!value) return;

    // --- CASO 1: Comentarios de Instagram (Reels / Posts) ---
    if (field === 'comments') {
        const commentId = value.id;
        const text = value.text;
        const fromUser = value.from;

        // Evitar responder comentarios de la propia página/cuenta
        if (!fromUser || fromUser.id === entryId) {
            return;
        }

        logger.info('Received Instagram comment', {
            commentId,
            from: fromUser.username,
            text
        });

        await processCommentReply({
            commentId,
            authorId: fromUser.id,
            authorName: fromUser.username,
            commentText: text,
            platform: 'instagram',
            storeId
        });
    }

    // --- CASO 2: Comentarios de Facebook en publicaciones del Feed ---
    if (field === 'feed' && value.item === 'comment' && value.verb === 'add') {
        const commentId = value.comment_id;
        const text = value.message;
        const fromUser = value.from;

        // Evitar responder a los propios comentarios de la página
        if (!fromUser || fromUser.id === entryId) {
            return;
        }

        logger.info('Received Facebook comment', {
            commentId,
            from: fromUser.name,
            text
        });

        await processCommentReply({
            commentId,
            authorId: fromUser.id,
            authorName: fromUser.name,
            commentText: text,
            platform: 'facebook',
            storeId
        });
    }
}

/**
 * Procesa la respuesta de la IA a un comentario público
 */
async function processCommentReply({ commentId, authorId, authorName, commentText, platform, storeId }) {
    try {
        // 1. Obtener o crear usuario
        const user = await getOrCreateMetaUser({
            metaId: authorId,
            platform,
            displayName: authorName,
            storeId
        });

        // 2. Obtener o crear chat para el seguimiento
        const chat = await getOrCreateMetaChat(user.id, `${platform}_comment`, storeId);

        // 3. Guardar el comentario como mensaje del usuario
        await saveMessage(
            chat.id,
            user.id,
            'user',
            `[Comentario en publicación]: ${commentText}`,
            { comment_id: commentId, platform }
        );

        // 4. Invocar el agente con contexto de que es un comentario público
        const agent = await getAgent();
        const threadId = generateThreadId(chat.id);
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const promptInstruction = `El usuario @${authorName || 'cliente'} dejó el siguiente comentario público en nuestras redes sociales: "${commentText}". Genera una respuesta breve, profesional, cordial y atractiva para responder su comentario de forma pública (máximo 2-3 frases), invitándolo si es pertinente a escribirnos por mensaje privado o consultar su proyecto.`;

        const result = await agent.invoke(
            {
                messages: [{ role: 'user', content: promptInstruction }],
                userPhone: `${platform}:${authorId}`,
                chatId: chat.id,
                userId: user.id
            },
            config
        );

        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = lastMessage.content;

        // 5. Guardar la respuesta
        await saveMessage(chat.id, user.id, 'assistant', responseText, { comment_id: commentId, platform });

        // 6. Publicar la respuesta en el comentario mediante Meta Graph API
        if (platform === 'instagram') {
            await replyInstagramComment(commentId, responseText);
        } else {
            await replyFacebookComment(commentId, responseText);
        }

        logger.info(`Comment replied successfully on ${platform}`, { commentId });

    } catch (error) {
        logger.error(`Error replying to comment on ${platform}`, {
            commentId,
            error: error.message,
            stack: error.stack
        });
    }
}

export default router;
