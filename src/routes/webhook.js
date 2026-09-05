import express from 'express';
import os from 'os';
import path from 'path';
import { getAgent } from '../agent/graph.js';
import { getOrCreateUser, getOrCreateChat, hasMessageSid, saveMessage } from '../services/supabase.js';
import { sendWhatsAppMessage, downloadMediaToFile } from '../services/twilio.js';
import { processInboundMedia } from '../services/mediaService.js';
import { processVideo, cleanupTempFiles } from '../utils/mediaProcessor.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { twilioWebhookValidator } from '../middleware/validator.js';
import { logger } from '../middleware/logger.js';
import { extractPhoneNumber, generateThreadId } from '../utils/session.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

/**
 * Endpoint principal para recibir mensajes de WhatsApp desde Twilio
 */
router.post('/whatsapp', twilioWebhookValidator, catchAsync(async (req, res) => {
    const { From, Body, MessageSid } = req.body;
    const numMedia = parseInt(req.body?.NumMedia || '0');
    const phoneNumber = extractPhoneNumber(From);

    logger.info('Received WhatsApp message', {
        from: phoneNumber,
        messageLength: Body?.length,
        hasMedia: numMedia > 0,
        numMedia,
        messageSid: MessageSid
    });

    try {
        // Obtener STORE_ID de la configuración (o metadata del número si fuera multi-número)
        const storeId = process.env.STORE_ID || null;

        // 1. Obtener o crear usuario
        const user = await getOrCreateUser(phoneNumber, storeId);
        logger.debug('User retrieved/created', { userId: user.id, storeId });

        // 2. Obtener o crear chat activo (anteriormente conversación)
        const chat = await getOrCreateChat(user.id, storeId);
        logger.debug('Chat retrieved/created', { chatId: chat.id });

        // 2.1 Idempotencia: si Twilio reintenta el mismo MessageSid, no reprocesar
        if (MessageSid) {
            const exists = await hasMessageSid(chat.id, MessageSid);
            if (exists) {
                logger.warn('Duplicate Twilio MessageSid ignored (idempotent)', {
                    chatId: chat.id,
                    messageSid: MessageSid
                });
                return res.status(200).send('OK');
            }
        }

        // LOGICA DE CONTENIDO + ADJUNTOS
        let messageContent = Body || '';
        let messageMetadata = {
            message_sid: MessageSid,
            from: From,
            attachments: []
        };

        // Procesar adjuntos con el nuevo servicio de Firebase
        if (numMedia > 0) {
            const mediaItems = [];
            for (let i = 0; i < numMedia; i++) {
                const mediaUrl = req.body?.[`MediaUrl${i}`];
                const mediaContentType = req.body?.[`MediaContentType${i}`];
                if (mediaUrl) {
                    mediaItems.push({ url: mediaUrl, contentType: mediaContentType });
                }
            }

            try {
                // Descarga de Twilio -> Sube a Firebase -> Genera URLs firmadas
                const attachments = await processInboundMedia(chat.id, MessageSid, mediaItems);
                
                messageMetadata.attachments = attachments;
                
                // --- ANÁLISIS DE IMÁGENES ---
                const firstImage = attachments.find(att => att.type === 'image');
                if (firstImage && firstImage.url) {
                    logger.info('Analyzing image with Vision service', { url: firstImage.url });
                    try {
                        const { analyzeImage } = await import('../services/visionService.js');
                        // Usamos la URL firmada de Firebase
                        const analysis = await analyzeImage(firstImage.url);
                        
                        messageMetadata.image_analysis = analysis;

                        if (analysis?.description) {
                            messageContent = messageContent 
                                ? `${messageContent}\n\n[Contexto Imagen: ${analysis.description}]`
                                : `[Imagen enviada por usuario: ${analysis.description}]`;
                        }
                        if (analysis?.text_content) {
                            messageContent += `\n[Texto en imagen: ${analysis.text_content}]`;
                        }

                    } catch (visionError) {
                        logger.error('Error analyzing image:', visionError);
                    }
                }

                // --- ANÁLISIS DE VIDEO ---
                const firstVideo = attachments.find(att => att.type === 'video');
                if (firstVideo && firstVideo.original_url) {
                     logger.info('Analyzing video content', { url: firstVideo.original_url });
                     const tempFiles = [];
                     try {
                        const { analyzeVideoFrames } = await import('../services/visionService.js');
                        
                        // 1. Descargar video a temp
                        const tempVideoPath = path.join(os.tmpdir(), `vid_${MessageSid}.mp4`);
                        await downloadMediaToFile(firstVideo.original_url, tempVideoPath);
                        tempFiles.push(tempVideoPath);

                        // 2. Procesar video (extraer audio y frames)
                        const { audioPath, frames } = await processVideo(tempVideoPath);
                        if (audioPath) tempFiles.push(audioPath);
                        if (frames) tempFiles.push(...frames);

                        // 3. Transcribir Audio
                        let transcription = "";
                        if (audioPath) {
                            transcription = await transcribeAudio(audioPath);
                        }

                        // 4. Analizar Frames con Visión
                        let visualDescription = "";
                        if (frames && frames.length > 0) {
                            const analysis = await analyzeVideoFrames(frames);
                            visualDescription = analysis?.description || "";
                        }

                        // 5. Construir contexto
                         const videoContext = [];
                         if (visualDescription) videoContext.push(`Visualmente: ${visualDescription}`);
                         if (transcription) videoContext.push(`Audio transcrito: "${transcription}"`);

                         if (videoContext.length > 0) {
                            const contextStr = videoContext.join('\n');
                            messageContent = messageContent 
                                ? `${messageContent}\n\n[Contexto Video:\n${contextStr}]`
                                : `[Video enviado por usuario:\n${contextStr}]`;
                            
                            // Guardar en metadata
                            messageMetadata.video_analysis = {
                                transcription,
                                visual_description: visualDescription
                            };
                         }

                     } catch (videoError) {
                         logger.error('Error analyzing video:', videoError);
                     } finally {
                         await cleanupTempFiles(tempFiles);
                     }
                }

                // --- ANÁLISIS DE AUDIO (NOTAS DE VOZ) ---
                const firstAudio = attachments.find(att => att.type === 'audio');
                if (firstAudio && firstAudio.original_url) {
                    logger.info('Analyzing audio content', { url: firstAudio.original_url });
                    const tempFiles = [];
                    try {
                        // 1. Descargar audio
                        // Extensión según mime type, default .mp3 o .ogg
                        const ext = firstAudio.mime?.includes('ogg') ? 'ogg' : 'mp3';
                        const tempAudioPath = path.join(os.tmpdir(), `aud_${MessageSid}.${ext}`);
                        await downloadMediaToFile(firstAudio.original_url, tempAudioPath);
                        tempFiles.push(tempAudioPath);

                        // 2. Transcribir
                        const transcription = await transcribeAudio(tempAudioPath);

                        if (transcription) {
                            messageContent = messageContent 
                                ? `${messageContent}\n\n[Audio Transcrito: "${transcription}"]`
                                : `[Nota de voz: "${transcription}"]`;
                            
                            messageMetadata.audio_transcription = transcription;
                        }

                    } catch (audioError) {
                        logger.error('Error analyzing audio:', audioError);
                    } finally {
                        await cleanupTempFiles(tempFiles);
                    }
                }

            } catch (mediaError) {
                logger.error('Error processing media items:', mediaError);
                // Continuamos aunque falle el media, para guardar al menos el mensaje de texto si existe
            }

            // Compatibilidad: mapear el primer adjunto a los campos históricos
            const first = messageMetadata.attachments[0];
            if (first?.original_url) messageMetadata.media_url = first.original_url;
            if (first?.storage_path) messageMetadata.storage_path = first.storage_path;
        }

        // 3. Guardar mensaje del usuario en la base de datos
        const hasAttachments = messageMetadata.attachments && messageMetadata.attachments.length > 0;
        let savedContent = Body || '';
        if (!savedContent && hasAttachments) {
            const firstAtt = messageMetadata.attachments[0];
            if (firstAtt.is_sticker || firstAtt.mime === 'image/webp') {
                savedContent = '[Sticker]';
            } else if (firstAtt.type === 'image') {
                savedContent = '[Foto]';
            } else if (firstAtt.type === 'audio') {
                savedContent = '[Nota de voz]';
            } else if (firstAtt.type === 'video') {
                savedContent = '[Video]';
            } else {
                savedContent = '[Archivo]';
            }
        } else if (!savedContent) {
            savedContent = '[Mensaje vacío]';
        }

        await saveMessage(
            chat.id,
            user.id,
            'user',
            savedContent,
            messageMetadata,
            MessageSid || null
        );

        // --- VALIDACIÓN HUMAN HANDOFF ---
        // Si la IA está pausada para este chat, terminamos aquí.
        // Ya se guardó el mensaje del usuario para que el humano lo vea en el panel.
        if (chat.is_ai_paused) {
            logger.info('Chat is in Human Handoff mode (AI paused). Skipping automated response.', {
                chatId: chat.id,
                userPhone: phoneNumber
            });
            return res.status(200).send('OK');
        }

        // 4. Obtener instancia del agente
        const agent = await getAgent();

        // 5. Configurar el thread para mantener memoria conversacional
        const threadId = generateThreadId(chat.id);
        const config = {
            configurable: {
                thread_id: threadId
            }
        };

        // --- VERIFICACIÓN DE ESTADO PERSISTENTE ---
        console.log("-----------------------------------------");
        console.log("Thread ID:", threadId);
        console.log("User Input:", messageContent);
        console.log("-----------------------------------------");

        // 6. Procesar mensaje con el agente
        // Inyectamos SOLO el mensaje nuevo. El historial completo vive en Postgres (checkpoints).
        logger.info('Invoking agent graph', { threadId });
        
        const result = await agent.invoke(
            {
                messages: [{ role: 'user', content: messageContent }],
                userPhone: phoneNumber,
                chatId: chat.id,
                userId: user.id
            },
            config
        );

        // 7. Extraer respuesta del agente
        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = lastMessage.content;

        logger.info('Agent response generated', {
            responseLength: responseText?.length,
            toolCalls: lastMessage.tool_calls?.length || 0
        });

        // 8. Guardar respuesta del agente en la base de datos
        await saveMessage(chat.id, user.id, 'assistant', responseText);

        // 9. Enviar respuesta por WhatsApp
        const twilioResponse = await sendWhatsAppMessage(phoneNumber, responseText);

        logger.info('Response sent to WhatsApp', {
            to: phoneNumber,
            twilioSid: twilioResponse.sid
        });

        // 10. Confirmar recepción a Twilio
        res.status(200).send('OK');

    } catch (error) {
        logger.error('Error processing WhatsApp message', {
            error: error.message,
            stack: error.stack,
            from: phoneNumber
        });

        // Intentar enviar mensaje de error al usuario
        try {
            await sendWhatsAppMessage(
                phoneNumber,
                'Lo siento, ocurrió un error al procesar tu mensaje. Por favor, intenta de nuevo.'
            );
        } catch (sendError) {
            logger.error('Error sending error message to user', { error: sendError.message });
        }

        // Responder a Twilio que hubo un error
        res.status(500).json({ error: 'Internal server error' });
    }
}));

/**
 * Endpoint para verificar el webhook (usado por Twilio durante configuración)
 */
router.get('/whatsapp', (req, res) => {
    res.status(200).send('WhatsApp webhook is active');
});

export default router;
