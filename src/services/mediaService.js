import axios from 'axios';
import { supabaseAdmin } from './supabase.js';

/**
 * Procesa los archivos multimedia entrantes de Twilio.
 * Descarga de Twilio -> Sube a Supabase Storage (bucket 'chat-media') -> Genera URL Pública
 * Fallback a Proxy de Twilio si ocurriera cualquier inconveniente.
 * 
 * @param {string} chatId - ID del chat en Supabase
 * @param {string} messageSid - SID del mensaje de Twilio (para unicidad)
 * @param {Array<{url: string, contentType: string}>} mediaItems - Lista de adjuntos
 * @returns {Promise<Array>} Lista de attachments procesados con metadatos
 */
export async function processInboundMedia(chatId, messageSid, mediaItems) {
    const attachments = [];
    
    // Autenticación para descargar media de Twilio
    const twilioAuth = {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
    };

    for (let i = 0; i < mediaItems.length; i++) {
        const { url: mediaUrl, contentType } = mediaItems[i];
        
        try {
            // 1. Descargar de Twilio
            const response = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                auth: twilioAuth
            });

            // 2. Determinar extensión y tipo
            const ext = getExtensionFromMime(contentType);
            const type = getTypeFromMime(contentType);
            const isSticker = contentType === 'image/webp';
            
            // 3. Definir ruta en Supabase Storage: chats/{chat_id}/messages/{message_sid}/{i}.{ext}
            const storagePath = `chats/${chatId}/messages/${messageSid}/${i}.${ext}`;
            
            // 4. Subir a Supabase Storage bucket 'chat-media'
            const { error: uploadError } = await supabaseAdmin.storage
                .from('chat-media')
                .upload(storagePath, response.data, {
                    contentType: contentType || 'application/octet-stream',
                    upsert: true
                });

            if (uploadError) {
                console.warn(`[Supabase Storage Warning] Error subiendo ${storagePath}:`, uploadError.message);
                throw uploadError;
            }

            // 5. Obtener URL Pública de Supabase
            const { data: publicUrlData } = supabaseAdmin.storage
                .from('chat-media')
                .getPublicUrl(storagePath);

            const fileUrl = publicUrlData?.publicUrl || `/api/media/proxy?url=${encodeURIComponent(mediaUrl)}`;

            attachments.push({
                type,
                mime: contentType,
                url: fileUrl,
                original_url: mediaUrl,
                storage_provider: 'supabase',
                storage_path: storagePath,
                is_sticker: isSticker
            });

        } catch (error) {
            console.error(`Error processing media ${i} (${mediaUrl}):`, error?.message || error);
            
            // Fallback a Proxy Autenticado de Twilio si falla la subida a almacenamiento
            const proxyUrl = `/api/media/proxy?url=${encodeURIComponent(mediaUrl)}`;
            const type = getTypeFromMime(contentType);
            
            attachments.push({
                type,
                mime: contentType,
                url: proxyUrl,
                original_url: mediaUrl,
                storage_provider: 'proxy',
                is_sticker: contentType === 'image/webp'
            });
        }
    }

    return attachments;
}

function getExtensionFromMime(mimeType) {
    if (!mimeType) return 'bin';
    const parts = mimeType.split('/');
    if (parts.length === 2) {
        // Manejar sub-tipos conocidos
        const sub = parts[1].split(';')[0];
        if (sub === 'jpeg') return 'jpg';
        return sub;
    }
    return 'bin';
}

function getTypeFromMime(mimeType) {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
}
