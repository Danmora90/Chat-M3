import express from 'express';
import axios from 'axios';
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
    replyFacebookComment,
    fetchCommentDetails,
    fetchPostMediaDetails,
    getAccessToken 
} from '../services/metaService.js';
import { getVideoContext } from '../services/videoContextService.js';
import { generateThreadId } from '../utils/session.js';

const router = express.Router();

/**
 * Endpoint de diagnóstico en vivo para verificar conexión real con Meta
 */
router.get('/debug-live', catchAsync(async (req, res) => {
    const rawToken = (process.env.META_PAGE_ACCESS_TOKEN || '').trim().replace(/^["']|["']$/g, '');
    const pageId = (process.env.META_PAGE_ID || '163693413486965').trim();
    const defaultCommentId = '122245599986092886_1144765577947549';
    const commentId = req.query.comment_id || defaultCommentId;
    const platform = req.query.platform || ((commentId !== defaultCommentId && commentId.length <= 18) ? 'instagram' : 'facebook');

    const results = {
        token_preview: rawToken ? `${rawToken.slice(0, 10)}...${rawToken.slice(-6)}` : 'MISSING',
        page_id: pageId,
        platform_tested: platform
    };

    // 1. Debug token vía debug_token
    try {
        const d = await axios.get(`https://graph.facebook.com/debug_token`, {
            params: { input_token: rawToken, access_token: rawToken },
            timeout: 7000
        });
        results.debug_token = d.data?.data;
    } catch (e) {
        results.debug_token_error = e.response?.data || e.message;
    }

    // 2. Resolver token mediante getAccessToken
    let resolved = null;
    try {
        resolved = await getAccessToken();
        results.resolved_token_preview = resolved ? `${resolved.slice(0, 10)}...${resolved.slice(-6)}` : 'NULL';
    } catch (e) {
        results.resolved_token_error = e.message;
    }

    const tokenToUse = resolved || rawToken;

    // 3. Probar lectura del comentario con los campos correspondientes a la plataforma
    try {
        const fields = platform === 'instagram' 
            ? 'text,from,timestamp,username' 
            : 'message,from,created_time';
        const c = await axios.get(`https://graph.facebook.com/v21.0/${commentId}`, {
            params: { fields, access_token: tokenToUse },
            timeout: 7000
        });
        results.comment_read = c.data;
    } catch (e) {
        results.comment_read_error = e.response?.data || e.message;
    }

    // 4. Probar envío de respuesta si ?test_reply=true
    if (req.query.test_reply === 'true') {
        try {
            if (platform === 'instagram') {
                const r = await replyInstagramComment(commentId, 'Hola! Respuesta automática verificada de Instagram desde el servidor.');
                results.reply_post = r;
            } else {
                const r = await replyFacebookComment(commentId, 'Hola Jose Daniel! Respuesta automática verificada desde el servidor.');
                results.reply_post = r;
            }
        } catch (e) {
            results.reply_post_error = e.response?.data || e.message;
        }
    }

    res.json(results);
}));

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
        const messageMetadata = { platform, meta_mid: messageMid };
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
            const firstAtt = message.attachments[0];
            const attUrl = firstAtt.payload?.url;
            if (attUrl) {
                messageMetadata.media_url = attUrl;
                messageMetadata.content_type = firstAtt.type === 'video' ? 'video/mp4' : 'image/jpeg';
                messageMetadata.attachments = [{
                    url: attUrl,
                    type: firstAtt.type || 'image',
                    mime: firstAtt.type === 'video' ? 'video/mp4' : 'image/jpeg',
                    content_type: firstAtt.type === 'video' ? 'video/mp4' : 'image/jpeg',
                    original_url: attUrl,
                    storage_provider: 'meta'
                }];
            }
        }

        await saveMessage(
            chat.id,
            user.id,
            'user',
            contentToProcess,
            messageMetadata,
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
        let text = value.text || value.message || '';
        const fromUser = value.from;
        let mediaId = value.media?.id || null;

        // Evitar responder comentarios de la propia página/cuenta
        if (!fromUser || fromUser.id === entryId || fromUser.username?.toLowerCase() === 'mas.3arquitectura') {
            return;
        }

        // Si el webhook de Instagram no trajo el texto del mensaje o el mediaId,
        // consultamos los detalles directamente a la Graph API antes de llamar a la IA
        if (!text || text.trim() === '' || !mediaId) {
            logger.info('Instagram webhook missing comment text or mediaId, fetching via Graph API...', { commentId, hasText: !!text, hasMediaId: !!mediaId });
            const details = await fetchCommentDetails(commentId, 'instagram');
            if (details?.text && (!text || text.trim() === '')) {
                text = details.text;
            }
            if (details?.mediaId && !mediaId) {
                mediaId = details.mediaId;
            }
        }

        logger.info('Received Instagram comment', {
            commentId,
            mediaId,
            from: fromUser.username,
            text
        });

        await processCommentReply({
            commentId,
            mediaId,
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
        let text = value.message || value.text || value.comment || '';
        const fromUser = value.from;
        const mediaId = value.post_id || value.parent_id || null;

        // Evitar responder a los propios comentarios de la página
        if (!fromUser || fromUser.id === entryId) {
            return;
        }

        // Si el webhook de Facebook no trajo el texto del mensaje (común en videos, reels o posts protegidos),
        // consultamos los detalles directamente a la Graph API antes de llamar a la IA
        if (!text || text.trim() === '') {
            logger.info('Facebook webhook omitted comment text, fetching via Graph API...', { commentId });
            const details = await fetchCommentDetails(commentId);
            if (details?.message) {
                text = details.message;
            }
        }

        const fallbackMedia = {
            mediaUrl: value.photo || value.video || null,
            postUrl: value.link || null
        };

        logger.info('Received Facebook comment', {
            commentId,
            mediaId,
            from: fromUser?.name,
            text,
            hasFallbackMedia: !!fallbackMedia.mediaUrl
        });

        await processCommentReply({
            commentId,
            mediaId,
            authorId: fromUser?.id,
            authorName: fromUser?.name,
            commentText: text,
            platform: 'facebook',
            storeId,
            fallbackMedia
        });
    }
}

/**
 * Procesa la respuesta de la IA a un comentario público
 */
async function processCommentReply({ commentId, mediaId, authorId, authorName, commentText, platform, storeId, fallbackMedia = null }) {
    let chat = null;
    let user = null;

    try {
        // 1. Obtener o crear usuario
        user = await getOrCreateMetaUser({
            metaId: authorId,
            platform,
            displayName: authorName,
            storeId
        });

        // 2. Obtener o crear chat para el seguimiento
        chat = await getOrCreateMetaChat(user.id, `${platform}_comment`, storeId);

        // 3. Consultar multimedia y análisis de contenido del video/Reel si mediaId está disponible
        let mediaDetails = null;
        let videoContext = null;
        if (mediaId) {
            try {
                mediaDetails = await fetchPostMediaDetails(mediaId, platform);
                if (mediaDetails) {
                    videoContext = await getVideoContext({
                        mediaId,
                        mediaUrl: mediaDetails.mediaUrl,
                        videoUrl: mediaDetails.videoUrl,
                        caption: mediaDetails.caption,
                        platform
                    });
                }
            } catch (mediaErr) {
                logger.warn('Failed to fetch post media or video context for comment', { mediaId, platform, error: mediaErr.message });
            }
        }

        // Si fetchPostMediaDetails no trajo datos pero el webhook trajo fallbackMedia
        if (!mediaDetails && fallbackMedia?.mediaUrl) {
            mediaDetails = {
                mediaId,
                mediaUrl: fallbackMedia.mediaUrl,
                videoUrl: null,
                mediaType: 'IMAGE',
                permalink: fallbackMedia.postUrl || null,
                caption: ''
            };
        }

        const cleanText = (commentText && commentText.trim() !== '' && commentText !== 'undefined' && commentText !== '[Comentario en publicación]') 
            ? commentText.trim() 
            : null;

        // Guardar el texto directo sin prefijo, o indicador descriptivo si no hubo texto
        const displayContent = cleanText || '[Comentario en publicación]';

        // Estructurar metadatos y adjuntos del mensaje para que el CRM renderice la imagen/miniatura
        const messageMetadata = {
            comment_id: commentId,
            platform,
            post_id: mediaId || null,
            post_url: mediaDetails?.permalink || null,
            post_caption: mediaDetails?.caption || null
        };

        if (videoContext) {
            messageMetadata.video_analysis = videoContext;
        }

        if (mediaDetails?.mediaUrl) {
            messageMetadata.media_url = mediaDetails.mediaUrl;
            messageMetadata.content_type = mediaDetails.mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
            messageMetadata.attachments = [{
                url: mediaDetails.mediaUrl,
                type: mediaDetails.mediaType === 'VIDEO' ? 'video' : 'image',
                mime: mediaDetails.mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
                content_type: mediaDetails.mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
                original_url: mediaDetails.mediaUrl,
                storage_provider: 'meta'
            }];
        }

        // 4. Guardar el comentario como mensaje del usuario en la base de datos
        await saveMessage(
            chat.id,
            user.id,
            'user',
            displayContent,
            messageMetadata
        );

        const postScope = mediaId || commentId || 'general';
        const threadId = generateThreadId(`${chat.id}_${postScope}`);

        // 5. Verificar si el chat está pausado por humano
        if (chat.is_ai_paused) {
            logger.info('Comment chat is in Human Handoff mode (AI paused). Skipping automated reply.', {
                chatId: chat.id,
                platform,
                postScope
            });

            await updateAgentMemory(
                chat.id,
                {
                    role: 'user',
                    content: displayContent
                },
                {
                    userId: user.id,
                    threadId
                }
            );

            return;
        }

        // 6. Invocar el agente con contexto enriquecido de la publicación y video
        const agent = await getAgent();
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const contextDetails = [];
        if (mediaDetails?.caption) {
            contextDetails.push(`- Título o texto publicado en redes: "${mediaDetails.caption}"`);
        }
        if (videoContext?.summary) {
            contextDetails.push(`- Tema y producto/servicio de lo que trata el video: ${videoContext.summary}`);
        }
        if (videoContext?.transcription) {
            contextDetails.push(`- Transcripción del audio hablado en el video: "${videoContext.transcription}"`);
        }
        if (videoContext?.visual_elements?.length > 0) {
            contextDetails.push(`- Acabados y elementos mostrados: ${videoContext.visual_elements.join(', ')}`);
        }

        let promptInstruction;
        if (contextDetails.length > 0) {
            const postContext = ` en nuestra publicación/Reel con la siguiente información:\n${contextDetails.join('\n')}\n`;
            promptInstruction = cleanText 
                ? `El usuario @${authorName || 'cliente'} dejó el siguiente comentario público${postContext}\nComentario/Pregunta del usuario: "${cleanText}". Responde a su pregunta con conocimiento exacto y específico de lo que se promociona y muestra en el video/publicación (máximo 2-3 frases), de forma profesional y cordial, invitándolo si es pertinente a escribirnos por mensaje privado para cotizar o conocer más detalles de su proyecto.`
                : `El usuario @${authorName || 'cliente'} interactuó con nuestra publicación/Reel${postContext}. Genera un saludo cordial y breve (máximo 2 frases) agradeciendo su interés e invitándolo a consultarnos por mensaje privado sobre sus proyectos.`;
        } else {
            promptInstruction = cleanText
                ? `El usuario @${authorName || 'cliente'} dejó el siguiente comentario público en una de nuestras publicaciones en redes sociales: "${cleanText}". NOTA IMPORTANTE: No se dispone de la descripción ni temática específica de esta publicación en particular. Responde de forma cordial, profesional y atractiva (máximo 2 frases), agradeciendo su interés e invitándolo a contarnos en qué proyecto, espacio o servicio de diseño/remodelación está interesado o a escribirnos por mensaje privado para brindarle toda la información y cotizaciones.`
                : `El usuario @${authorName || 'cliente'} interactuó con una de nuestras publicaciones en redes sociales. Genera un saludo cordial y breve (máximo 2 frases) agradeciendo su interés e invitándolo a consultarnos por mensaje privado sobre sus proyectos.`;
        }

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

        // 7. Publicar primero en Meta Graph API para validar la entrega real
        let replyResult = null;
        if (platform === 'instagram') {
            replyResult = await replyInstagramComment(commentId, responseText);
        } else {
            replyResult = await replyFacebookComment(commentId, responseText);
        }

        // 8. Guardar la respuesta en la base de datos SOLO si Meta la aceptó
        await saveMessage(chat.id, user.id, 'assistant', responseText, {
            comment_id: commentId,
            reply_id: replyResult?.id || null,
            platform
        });

        logger.info(`Comment replied successfully on ${platform}`, { commentId, replyId: replyResult?.id });

    } catch (error) {
        logger.error(`Error replying to comment on ${platform}`, {
            commentId,
            error: error.message,
            stack: error.stack
        });
    }
}

export default router;
