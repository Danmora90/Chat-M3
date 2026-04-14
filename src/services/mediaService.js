import axios from 'axios';
import { uploadFile, getSignedUrl as getFirebaseSignedUrl } from './firebase.js';

/**
 * Procesa los archivos multimedia entrantes de Twilio.
 * Descarga de Twilio -> Sube a Firebase -> Genera URL firmada
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
            // Twilio puede redirigir, axios sigue redirecciones por defecto
            const response = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                auth: twilioAuth
            });

            // 2. Determinar extensión y tipo
            const ext = getExtensionFromMime(contentType);
            const type = getTypeFromMime(contentType);
            
            // 3. Definir ruta en Firebase: chats/{chat_id}/messages/{message_sid}/{i}.{ext}
            const storagePath = `chats/${chatId}/messages/${messageSid}/${i}.${ext}`;
            
            // 4. Subir a Firebase
            await uploadFile(response.data, storagePath, contentType);

            // 5. Generar URL firmada inicial (para guardar en BD y que el front la tenga rápido)
            // Se puede configurar expiración larga (ej. 7 días)
            const { signedUrl, expiresAt } = await getFirebaseSignedUrl(storagePath, 7);

            attachments.push({
                type,
                mime: contentType,
                url: signedUrl, // URL lista para usar
                original_url: mediaUrl, // URL original de Twilio (backup)
                storage_provider: 'firebase',
                storage_path: storagePath,
                expires_at: expiresAt
            });

        } catch (error) {
            console.error(`Error processing media ${i} (${mediaUrl}):`, error);
            // Agregamos con error para no perder referencia de que había algo
            attachments.push({
                type: 'unknown',
                mime: contentType,
                original_url: mediaUrl,
                error: error.message
            });
        }
    }

    return attachments;
}

function getExtensionFromMime(mimeType) {
    if (!mimeType) return 'bin';
    const parts = mimeType.split('/');
    if (parts.length === 2) return parts[1];
    return 'bin';
}

function getTypeFromMime(mimeType) {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
}
