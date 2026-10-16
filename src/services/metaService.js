import axios from 'axios';
import { logger } from '../middleware/logger.js';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Obtiene el Page Access Token configurado
 */
function getAccessToken() {
    const token = process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) {
        throw new Error('META_PAGE_ACCESS_TOKEN no está configurado en las variables de entorno.');
    }
    return token;
}

/**
 * Envía un mensaje directo (DM) por Facebook Messenger
 * @param {string} recipientId - PSID del destinatario
 * @param {string} text - Texto del mensaje a enviar
 * @returns {Promise<Object>} Respuesta de la Graph API
 */
export async function sendMessengerMessage(recipientId, text) {
    try {
        const token = getAccessToken();
        const url = `${GRAPH_API_BASE}/me/messages`;

        const response = await axios.post(
            url,
            {
                recipient: { id: recipientId },
                message: { text }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                }
            }
        );

        logger.info('Messenger message sent successfully', {
            recipientId,
            messageId: response.data?.message_id
        });

        return response.data;
    } catch (error) {
        logger.error('Error sending Messenger message', {
            recipientId,
            error: error.response?.data || error.message
        });
        throw error;
    }
}

/**
 * Envía un mensaje directo (DM) por Instagram
 * @param {string} recipientId - IGSID del usuario de Instagram
 * @param {string} text - Texto del mensaje a responder
 * @returns {Promise<Object>} Respuesta de la Graph API
 */
export async function sendInstagramMessage(recipientId, text) {
    try {
        const token = getAccessToken();
        const url = `${GRAPH_API_BASE}/me/messages`;

        const response = await axios.post(
            url,
            {
                recipient: { id: recipientId },
                message: { text }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                }
            }
        );

        logger.info('Instagram DM sent successfully', {
            recipientId,
            messageId: response.data?.message_id
        });

        return response.data;
    } catch (error) {
        logger.error('Error sending Instagram DM', {
            recipientId,
            error: error.response?.data || error.message
        });
        throw error;
    }
}

/**
 * Responde a un comentario en una publicación o Reel de Instagram
 * @param {string} commentId - ID del comentario de Instagram
 * @param {string} text - Respuesta pública
 * @returns {Promise<Object>} ID de la respuesta creada
 */
export async function replyInstagramComment(commentId, text) {
    try {
        const token = getAccessToken();
        const url = `${GRAPH_API_BASE}/${commentId}/replies`;

        const response = await axios.post(
            url,
            { message: text },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                }
            }
        );

        logger.info('Instagram comment replied successfully', {
            commentId,
            replyId: response.data?.id
        });

        return response.data;
    } catch (error) {
        logger.error('Error replying to Instagram comment', {
            commentId,
            error: error.response?.data || error.message
        });
        throw error;
    }
}

/**
 * Responde a un comentario en una publicación de Facebook
 * @param {string} commentId - ID del comentario de Facebook
 * @param {string} text - Respuesta pública
 * @returns {Promise<Object>} ID de la respuesta creada
 */
export async function replyFacebookComment(commentId, text) {
    try {
        const token = getAccessToken();
        const url = `${GRAPH_API_BASE}/${commentId}/comments`;

        const response = await axios.post(
            url,
            { message: text },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                }
            }
        );

        logger.info('Facebook comment replied successfully', {
            commentId,
            replyId: response.data?.id
        });

        return response.data;
    } catch (error) {
        logger.error('Error replying to Facebook comment', {
            commentId,
            error: error.response?.data || error.message
        });
        throw error;
    }
}
