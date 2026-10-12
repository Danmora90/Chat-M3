import twilio from 'twilio';
import axios from 'axios';
import fs from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';

const streamPipeline = promisify(pipeline);

/**
 * Cliente de Twilio configurado con credenciales
 */
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

/**
 * Envía un mensaje de WhatsApp a través de Twilio
 * @param {string} to - Número de teléfono del destinatario (sin whatsapp: prefix)
 * @param {string} message - Contenido del mensaje
 * @param {string} [mediaUrl] - URL pública opcional de medios a incluir
 * @returns {Promise<Object>} Respuesta de Twilio
 */
export async function sendWhatsAppMessage(to, message, mediaUrl = null) {
    try {
        const payload = {
            from: process.env.TWILIO_PHONE_NUMBER,
            to: `whatsapp:${to}`,
            body: message
        };

        if (mediaUrl) {
            payload.mediaUrl = [mediaUrl];
        }

        if (process.env.TWILIO_STATUS_CALLBACK_URL) {
            payload.statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
        }

        const response = await client.messages.create(payload);

        return response;
    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        throw error;
    }
}

/**
 * Envía una plantilla de WhatsApp a través de Twilio usando ContentSid y ContentVariables
 * @param {string} to - Número de teléfono del destinatario (con o sin whatsapp:)
 * @param {string} contentSid - SID de la plantilla en Twilio (HX...)
 * @param {Object} contentVariables - Variables dinámicas { "1": "valor", "2": "valor" }
 * @returns {Promise<Object>} Respuesta de Twilio
 */
export async function sendWhatsAppTemplate(to, contentSid, contentVariables = {}) {
    try {
        const cleanTo = String(to).replace(/^whatsapp:/i, '').trim().replace(/[^\d+]/g, '');
        const formattedTo = `whatsapp:${cleanTo.startsWith('+') ? cleanTo : `+${cleanTo}`}`;

        const rawFrom = process.env.TWILIO_PHONE_NUMBER || '+573045544151';
        const cleanFrom = rawFrom.replace(/^whatsapp:/i, '').trim().replace(/[^\d+]/g, '');
        const formattedFrom = `whatsapp:${cleanFrom.startsWith('+') ? cleanFrom : `+${cleanFrom}`}`;

        const payload = {
            from: formattedFrom,
            to: formattedTo,
            contentSid: contentSid,
            contentVariables: JSON.stringify(contentVariables)
        };

        if (process.env.TWILIO_STATUS_CALLBACK_URL) {
            payload.statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL;
        }

        const response = await client.messages.create(payload);
        return response;
    } catch (error) {
        console.error(`Error sending WhatsApp template to ${to}:`, error.message || error);
        throw error;
    }
}

/**
 * Valida la firma de un webhook de Twilio
 * @param {string} signature - Firma del header X-Twilio-Signature
 * @param {string} url - URL completa del webhook
 * @param {Object} params - Parámetros del request
 * @returns {boolean} True si la firma es válida
 */
export function validateTwilioSignature(signature, url, params) {
    try {
        return twilio.validateRequest(
            process.env.TWILIO_AUTH_TOKEN,
            signature,
            url,
            params
        );
    } catch (error) {
        console.error('Error validating Twilio signature:', error);
        return false;
    }
}

/**
 * Descarga el contenido multimedia de una URL de Twilio a un archivo local
 * @param {string} mediaUrl - URL del medio
 * @param {string} localPath - Ruta donde guardar el archivo
 */
export async function downloadMediaToFile(mediaUrl, localPath) {
    try {
        const timeout = parseInt(process.env.TWILIO_MEDIA_TIMEOUT_MS || '60000'); // Más tiempo para videos

        const response = await axios.get(mediaUrl, {
            responseType: 'stream',
            timeout,
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            validateStatus: (status) => status >= 200 && status < 300
        });

        await streamPipeline(response.data, fs.createWriteStream(localPath));
        return localPath;
    } catch (error) {
        console.error('Error downloading media to file:', error.message);
        throw error;
    }
}

/**
 * Descarga el contenido multimedia de una URL de Twilio usando autenticación
 * @param {string} mediaUrl - URL del medio (imagen, audio, etc.)
 * @returns {Promise<string>} Data URI en base64 (ej: data:image/jpeg;base64,...)
 */
export async function downloadMedia(mediaUrl) {
    try {
        const timeout = parseInt(process.env.TWILIO_MEDIA_TIMEOUT_MS || '20000');
        const maxBytes = parseInt(process.env.TWILIO_MEDIA_MAX_BYTES || '15728640'); // 15MB

        // Twilio requiere Basic Auth con Account SID y Auth Token
        const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout,
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            validateStatus: (status) => status >= 200 && status < 300
        });

        const contentType = String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        const base64Content = Buffer.from(response.data, 'binary').toString('base64');

        return `data:${contentType};base64,${base64Content}`;
    } catch (error) {
        console.error('Error downloading media from Twilio:', error.message);
        throw error;
    }
}

/**
 * Descarga el contenido multimedia de una URL de Twilio como Buffer
 * @param {string} mediaUrl - URL del medio
 * @returns {Promise<Object>} Object con buffer y contentType
 */
export async function downloadMediaBuffer(mediaUrl) {
    try {
        const timeout = parseInt(process.env.TWILIO_MEDIA_TIMEOUT_MS || '20000');
        const maxBytes = parseInt(process.env.TWILIO_MEDIA_MAX_BYTES || '15728640'); // 15MB

        const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout,
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            validateStatus: (status) => status >= 200 && status < 300
        });

        return {
            buffer: Buffer.from(response.data, 'binary'),
            contentType: String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
        };
    } catch (error) {
        console.error('Error downloading media buffer from Twilio:', error.message);
        throw error;
    }
}
