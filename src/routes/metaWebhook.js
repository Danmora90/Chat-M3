import express from 'express';
import axios from 'axios';
import path from 'path';
import os from 'os';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';
import { getAgent, updateAgentMemory } from '../agent/graph.js';
import { 
    getOrCreateMetaUser, 
    getOrCreateMetaChat, 
    saveMessage,
    hasMessageSid,
    supabaseAdmin
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
import { analyzeImage, analyzeVideoFrames } from '../services/visionService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { downloadPublicMediaToFile, processVideo, cleanupTempFiles } from '../utils/mediaProcessor.js';
import { generateThreadId } from '../utils/session.js';

const router = express.Router();

/**
 * Búfer en memoria para agrupar mensajes y adjuntos consecutivos de un mismo usuario (Debounce).
 * Evita respuestas dobles o fragmentadas cuando un usuario envía texto y fotos con pocos segundos de diferencia.
 */
const metaDebounceMap = new Map();
const META_DEBOUNCE_WAIT_MS = 4500; // 4.5 segundos de espera para agrupar
const META_DEBOUNCE_MAX_WAIT_MS = 12000; // Máximo 12 segundos acumulados

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
 * Manejador de Mensajes Directos (Messenger o Instagram Direct) con soporte multimodal completo:
 * - Imágenes / Planos / Comprobantes (Visión GPT-4o)
 * - Notas de voz / Audios (Whisper)
 * - Videos (Extracción de audio + Whisper + Frames con GPT-4o)
 * - Documentos y Contenido compartido
 */
async function handleDirectMessage(event, isInstagramObject, storeId, entryId) {
    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const message = event.message;

    // Ignorar si no hay mensaje, si es un echo (enviado por la propia página) o si el remitente es la página
    if (!message || message.is_echo || senderId === entryId) {
        return;
    }

    const platform = isInstagramObject ? 'instagram' : 'facebook';
    const messageText = (message.text || '').trim();
    const messageMid = message.mid;
    const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];

    // Si no hay texto ni adjuntos ni quick_reply ni story_share, no hay nada que procesar
    if (!messageText && rawAttachments.length === 0 && !message.quick_reply && !message.story_share) {
        return;
    }

    const tempFiles = [];

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

        // 4. Procesamiento de adjuntos multimedia y enriquecimiento de contexto
        const processedAttachments = [];
        const attachmentsContext = [];
        let audioTranscriptionText = '';
        const messageMetadata = { platform, meta_mid: messageMid };

        // Si es una respuesta o interacción con historia de Instagram
        if (message.story_share) {
            const storyUrl = message.story_share.link || '';
            attachmentsContext.push(`[El usuario interactuó con una historia de Instagram${storyUrl ? `: ${storyUrl}` : ''}]`);
        }

        for (let i = 0; i < rawAttachments.length; i++) {
            const rawAtt = rawAttachments[i];
            const attType = rawAtt.type || 'file';
            const attUrl = rawAtt.payload?.url || rawAtt.url;
            const attTitle = rawAtt.payload?.title || rawAtt.title || null;

            if (!attUrl) {
                if (rawAtt.type === 'fallback' || rawAtt.type === 'share') {
                    if (attTitle) {
                        attachmentsContext.push(`[Contenido compartido: ${attTitle}]`);
                    }
                }
                continue;
            }

            let mime = 'application/octet-stream';
            if (attType === 'image') mime = 'image/jpeg';
            else if (attType === 'audio') mime = 'audio/mp4';
            else if (attType === 'video') mime = 'video/mp4';
            else if (attType === 'file') mime = 'application/pdf';

            const attachmentRecord = {
                type: attType,
                url: attUrl,
                original_url: attUrl,
                mime,
                content_type: mime,
                title: attTitle,
                storage_provider: 'meta'
            };
            processedAttachments.push(attachmentRecord);

            // A) IMÁGENES (Fotos de espacios, planos arquitectónicos, renders, comprobantes)
            if (attType === 'image') {
                logger.info('Analyzing incoming Meta image with Vision service', { url: attUrl });
                try {
                    const analysis = await analyzeImage(attUrl);
                    if (analysis && !analysis.error) {
                        messageMetadata.image_analysis = analysis;
                        const imageParts = [];
                        if (analysis.space_type) {
                            imageParts.push(`Tipo de contenido: ${analysis.space_type}${analysis.is_blueprint ? ' (Plano arquitectónico)' : ''}`);
                        }
                        if (analysis.description) {
                            imageParts.push(`Descripción visual: ${analysis.description}`);
                        }
                        if (analysis.text_content) {
                            imageParts.push(`Texto/Medidas detectadas en la imagen: ${analysis.text_content}`);
                        }

                        if (imageParts.length > 0) {
                            attachmentsContext.push(`[Imagen enviada por el usuario:\n${imageParts.join('\n')}]`);
                        } else if (analysis.summary) {
                            attachmentsContext.push(`[Imagen enviada por el usuario: ${analysis.summary}]`);
                        }
                    } else {
                        attachmentsContext.push('[El usuario envió una imagen]');
                    }
                } catch (imgErr) {
                    logger.error('Error analyzing Meta image:', imgErr);
                    attachmentsContext.push('[El usuario envió una imagen]');
                }
            }

            // B) AUDIO / NOTAS DE VOZ (Transcripción con Whisper)
            else if (attType === 'audio') {
                logger.info('Analyzing incoming Meta audio note', { url: attUrl });
                try {
                    const ext = mime.includes('ogg') ? 'ogg' : 'mp4';
                    const tempAudioPath = path.join(os.tmpdir(), `meta_aud_${messageMid || Date.now()}_${i}.${ext}`);
                    await downloadPublicMediaToFile(attUrl, tempAudioPath);
                    tempFiles.push(tempAudioPath);

                    const transcription = await transcribeAudio(tempAudioPath);
                    if (transcription && transcription.trim().length > 0) {
                        messageMetadata.audio_transcription = transcription.trim();
                        audioTranscriptionText = transcription.trim();
                        logger.info('Meta audio transcribed successfully', { textLength: transcription.trim().length });
                    }
                } catch (audErr) {
                    logger.error('Error analyzing Meta audio note:', audErr);
                }
            }

            // C) VIDEOS (Extracción de audio + frames)
            else if (attType === 'video') {
                logger.info('Analyzing incoming Meta video', { url: attUrl });
                try {
                    const tempVideoPath = path.join(os.tmpdir(), `meta_vid_${messageMid || Date.now()}_${i}.mp4`);
                    await downloadPublicMediaToFile(attUrl, tempVideoPath);
                    tempFiles.push(tempVideoPath);

                    const { audioPath, frames } = await processVideo(tempVideoPath);
                    if (audioPath) tempFiles.push(audioPath);
                    if (frames && frames.length > 0) tempFiles.push(...frames);

                    let videoTranscription = '';
                    if (audioPath) {
                        videoTranscription = await transcribeAudio(audioPath);
                    }

                    let visualDescription = '';
                    if (frames && frames.length > 0) {
                        const frameAnalysis = await analyzeVideoFrames(frames);
                        visualDescription = frameAnalysis?.description || '';
                    }

                    messageMetadata.video_analysis = {
                        transcription: videoTranscription,
                        visual_description: visualDescription
                    };

                    const videoParts = [];
                    if (visualDescription) {
                        videoParts.push(`Descripción visual: ${visualDescription}`);
                    }
                    if (videoTranscription) {
                        videoParts.push(`Audio transcrito: "${videoTranscription}"`);
                    }

                    if (videoParts.length > 0) {
                        attachmentsContext.push(`[Video enviado por el cliente:\n${videoParts.join('\n')}]`);
                    } else {
                        attachmentsContext.push('[El usuario envió un video]');
                    }
                } catch (vidErr) {
                    logger.error('Error analyzing Meta video:', vidErr);
                    attachmentsContext.push('[El usuario envió un video]');
                }
            }

            // D) ARCHIVOS / DOCUMENTOS (PDF, etc.)
            else if (attType === 'file') {
                const docName = attTitle || 'documento adjunto';
                attachmentsContext.push(`[Archivo/Documento enviado por el usuario: ${docName}]`);
            }

            // E) COMPARTIDOS (Reels, publicaciones, enlaces)
            else if (attType === 'share') {
                const shareTitle = attTitle || 'publicación o reel de Instagram';
                attachmentsContext.push(`[El usuario compartió: ${shareTitle} (${attUrl})]`);
            }
        }

        // Determinar el contenido limpio para visualización en el CRM (displayContent)
        let displayContent = messageText;

        if (!displayContent) {
            if (messageMetadata.image_analysis?.is_blueprint) {
                displayContent = '[Plano arquitectónico]';
            } else if (processedAttachments.some(a => a.type === 'image')) {
                displayContent = '[Imagen]';
            } else if (audioTranscriptionText) {
                displayContent = `[Nota de voz: "${audioTranscriptionText}"]`;
            } else if (processedAttachments.some(a => a.type === 'audio')) {
                displayContent = '[Nota de voz]';
            } else if (processedAttachments.some(a => a.type === 'video')) {
                displayContent = '[Video]';
            } else if (processedAttachments.some(a => a.type === 'file')) {
                const docName = processedAttachments[0].title || 'Documento adjunto';
                displayContent = `[Archivo: ${docName}]`;
            } else if (message.story_share) {
                displayContent = '[Interacción con historia de Instagram]';
            } else if (processedAttachments.length > 0) {
                displayContent = '[Archivo adjunto]';
            } else {
                displayContent = '[Mensaje recibido]';
            }
        }

        // Construir promptContext integrando texto, transcripción y contexto visual enriquecido para la IA
        let promptContext = messageText;

        // Si hubo nota de voz transcrita, la incorporamos
        if (audioTranscriptionText) {
            promptContext = promptContext
                ? `${promptContext}\n\n[Nota de voz del usuario: "${audioTranscriptionText}"]`
                : `[Nota de voz del usuario: "${audioTranscriptionText}"]`;
        }

        // Si hubo imágenes, videos o documentos, adjuntamos la información contextual
        if (attachmentsContext.length > 0) {
            const contextBlock = attachmentsContext.join('\n\n');
            promptContext = promptContext
                ? `${promptContext}\n\n${contextBlock}`
                : contextBlock;
        }

        if (!promptContext) {
            promptContext = displayContent;
        }

        // Enlazar metadatos de adjuntos para visualización en el CRM
        if (processedAttachments.length > 0) {
            messageMetadata.attachments = processedAttachments;
            messageMetadata.media_url = processedAttachments[0].url;
            messageMetadata.content_type = processedAttachments[0].content_type;
        }

        logger.info(`Received ${platform} direct message with full multimodal context`, {
            from: senderId,
            mid: messageMid,
            hasAttachments: processedAttachments.length > 0,
            attachmentTypes: processedAttachments.map(a => a.type),
            length: promptContext.length
        });

        // 5. Guardar mensaje del usuario de inmediato con displayContent limpio para el CRM
        await saveMessage(
            chat.id,
            user.id,
            'user',
            displayContent,
            messageMetadata,
            messageMid || null
        );

        // 6. Verificar si el chat está pausado por humano
        if (chat.is_ai_paused) {
            logger.info('Chat is in Human Handoff mode (AI paused). Skipping automated response.', {
                chatId: chat.id,
                platform
            });

            await updateAgentMemory(
                chat.id,
                {
                    role: 'user',
                    content: promptContext
                },
                {
                    userId: user.id
                }
            );

            return;
        }

        // 7. Encolar en el búfer de debounce para responder con una sola llamada consolidada
        queueMetaMessageForAi({
            chatId: chat.id,
            userId: user.id,
            senderId,
            platform,
            promptContext
        });

    } catch (err) {
        logger.error(`Error processing ${platform} message`, {
            error: err.message,
            stack: err.stack,
            from: senderId
        });
    } finally {
        if (tempFiles.length > 0) {
            await cleanupTempFiles(tempFiles);
        }
    }
}

/**
 * Encola un mensaje o adjunto en el búfer de debounce para evitar respuestas dobles
 */
function queueMetaMessageForAi({ chatId, userId, senderId, platform, promptContext }) {
    let existing = metaDebounceMap.get(chatId);

    if (existing) {
        clearTimeout(existing.timer);
        existing.contexts.push(promptContext);

        const elapsed = Date.now() - existing.firstReceivedAt;
        const remainingUntilMax = Math.max(1000, META_DEBOUNCE_MAX_WAIT_MS - elapsed);
        const delay = Math.min(META_DEBOUNCE_WAIT_MS, remainingUntilMax);

        logger.info('Debounce: Appending consecutive Meta message to pending buffer', {
            chatId,
            bufferedCount: existing.contexts.length,
            nextExecutionInMs: delay
        });

        existing.timer = setTimeout(() => {
            executeBufferedMetaResponse(chatId).catch(err => {
                logger.error('Error executing buffered Meta response', {
                    chatId,
                    error: err.message,
                    stack: err.stack
                });
            });
        }, delay);
    } else {
        logger.info('Debounce: Starting buffer window for Meta user', {
            chatId,
            senderId,
            delayMs: META_DEBOUNCE_WAIT_MS
        });

        const entry = {
            chatId,
            userId,
            senderId,
            platform,
            firstReceivedAt: Date.now(),
            contexts: [promptContext],
            timer: null
        };

        entry.timer = setTimeout(() => {
            executeBufferedMetaResponse(chatId).catch(err => {
                logger.error('Error executing buffered Meta response', {
                    chatId,
                    error: err.message,
                    stack: err.stack
                });
            });
        }, META_DEBOUNCE_WAIT_MS);

        metaDebounceMap.set(chatId, entry);
    }
}

/**
 * Procesa los mensajes acumulados en el búfer de debounce, invocando a la IA una sola vez
 * y despachando la respuesta oficial a Meta con confirmación de entrega y trazabilidad en BD.
 */
async function executeBufferedMetaResponse(chatId) {
    const buffer = metaDebounceMap.get(chatId);
    if (!buffer) return;
    metaDebounceMap.delete(chatId);

    const { userId, senderId, platform, contexts } = buffer;
    if (!contexts || contexts.length === 0) return;

    try {
        // 1. Re-verificar si en la ventana de espera un asesor humano intervino o pausó el chat
        const { data: latestChat, error: chatErr } = await supabaseAdmin
            .from('chats')
            .select('is_ai_paused')
            .eq('id', chatId)
            .single();

        if (chatErr) {
            logger.warn('Could not fetch latest chat status before executing AI response', { chatId, error: chatErr.message });
        }

        if (latestChat?.is_ai_paused) {
            logger.info('Chat was paused by human during debounce window. Suppressing automated AI response.', { chatId });
            return;
        }

        // 2. Unificar los contextos acumulados en un solo turno para el agente
        const combinedPrompt = contexts.length === 1
            ? contexts[0]
            : contexts.join('\n\n');

        logger.info('Invoking AI agent with buffered Meta context', {
            chatId,
            senderId,
            messageCount: contexts.length,
            promptLength: combinedPrompt.length
        });

        // 3. Invocar al agente IA
        const agent = await getAgent();
        const threadId = generateThreadId(chatId);
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        const result = await agent.invoke(
            {
                messages: [{ role: 'user', content: combinedPrompt }],
                userPhone: `${platform}:${senderId}`,
                chatId,
                userId
            },
            config
        );

        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = lastMessage?.content || '';

        // Si el agente produjo un texto vacío o se activó la directiva interna de silencio
        if (!responseText || responseText.trim().length === 0) {
            logger.warn('Agent produced empty response for buffered Meta DM', { chatId });
            return;
        }

        if (responseText.toLowerCase().includes('silencio y atención humana') || responseText.toLowerCase().includes('silencio y atencion humana')) {
            logger.info('Silence / Human attention triggered by agent, pausing chat AI and suppressing auto-reply', { chatId });
            await supabaseAdmin.from('chats').update({ is_ai_paused: true }).eq('id', chatId);
            return;
        }

        // 4. Intentar enviar mensaje a Meta Graph API
        let metaSendResult = null;
        let deliveryStatus = 'delivered';
        let deliveryError = null;

        try {
            if (platform === 'instagram') {
                metaSendResult = await sendInstagramMessage(senderId, responseText);
            } else {
                metaSendResult = await sendMessengerMessage(senderId, responseText);
            }
            logger.info(`${platform} message delivered successfully to Meta`, {
                to: senderId,
                messageId: metaSendResult?.message_id
            });
        } catch (apiError) {
            deliveryStatus = 'failed';
            deliveryError = apiError.response?.data?.error?.message || apiError.message;
            logger.error(`Error sending message to Meta API on ${platform}`, {
                to: senderId,
                error: deliveryError,
                details: apiError.response?.data
            });
        }

        // 5. Guardar la respuesta del asistente en Supabase SIEMPRE con el estado de entrega real
        await saveMessage(chatId, userId, 'assistant', responseText, {
            platform,
            delivery_status: deliveryStatus,
            delivery_error: deliveryError,
            meta_mid: metaSendResult?.message_id || null
        });

    } catch (error) {
        logger.error('Critical error in executeBufferedMetaResponse', {
            chatId,
            senderId,
            error: error.message,
            stack: error.stack
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

        // 7. Intentar publicar en Meta Graph API
        let replyResult = null;
        let deliveryStatus = 'delivered';
        let deliveryError = null;

        try {
            if (platform === 'instagram') {
                replyResult = await replyInstagramComment(commentId, responseText);
            } else {
                replyResult = await replyFacebookComment(commentId, responseText);
            }
            logger.info(`Comment replied successfully on ${platform}`, { commentId, replyId: replyResult?.id });
        } catch (apiError) {
            deliveryStatus = 'failed';
            deliveryError = apiError.response?.data?.error?.message || apiError.message;
            logger.error(`Error publishing reply to Meta on ${platform}`, {
                commentId,
                error: deliveryError
            });
        }

        // 8. Guardar la respuesta de la IA en la base de datos SIEMPRE para que el CRM nunca pierda la conversación
        await saveMessage(chat.id, user.id, 'assistant', responseText, {
            comment_id: commentId,
            reply_id: replyResult?.id || null,
            platform,
            delivery_status: deliveryStatus,
            delivery_error: deliveryError
        });

    } catch (error) {
        logger.error(`Error replying to comment on ${platform}`, {
            commentId,
            error: error.message,
            stack: error.stack
        });
    }
}

export default router;
