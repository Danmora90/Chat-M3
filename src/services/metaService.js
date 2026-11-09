import axios from 'axios';
import { logger } from '../middleware/logger.js';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

let cachedResolvedToken = null;
let lastResolvedAt = 0;

/**
 * Obtiene el Page Access Token configurado.
 * Si el token es de un Usuario del Sistema, resuelve automáticamente el token de la Página MAS.3.
 */
async function getAccessToken() {
    const rawToken = process.env.META_PAGE_ACCESS_TOKEN;
    if (!rawToken) {
        throw new Error('META_PAGE_ACCESS_TOKEN no está configurado en las variables de entorno.');
    }

    // Cache por 1 hora para evitar llamadas repetitivas
    if (cachedResolvedToken && (Date.now() - lastResolvedAt < 3600 * 1000)) {
        return cachedResolvedToken;
    }

    try {
        // Intentar ver si es un token de Usuario / Sistema para obtener el token específico de la Página
        const accountsRes = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
            headers: { Authorization: `Bearer ${rawToken}` },
            timeout: 5000
        });

        const targetPageId = process.env.META_PAGE_ID || '163693413486965';
        const pages = accountsRes.data?.data || [];
        const targetPage = pages.find(p => p.id === targetPageId) || pages[0];

        if (targetPage?.access_token) {
            logger.info('Auto-resolved Page Access Token from System User', {
                pageId: targetPage.id,
                pageName: targetPage.name
            });
            cachedResolvedToken = targetPage.access_token;
            lastResolvedAt = Date.now();
            return cachedResolvedToken;
        }
    } catch (err) {
        // Si /me/accounts no aplica (por ejemplo si ya es un Page Access Token directo), usar el rawToken
        cachedResolvedToken = rawToken;
        lastResolvedAt = Date.now();
        return rawToken;
    }

    cachedResolvedToken = rawToken;
    lastResolvedAt = Date.now();
    return rawToken;
}

/**
 * Envía un mensaje directo (DM) por Facebook Messenger
 * @param {string} recipientId - PSID del destinatario
 * @param {string} text - Texto del mensaje a enviar
 * @returns {Promise<Object>} Respuesta de la Graph API
 */
export async function sendMessengerMessage(recipientId, text) {
    try {
        const token = await getAccessToken();
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
        const token = await getAccessToken();
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
        const token = await getAccessToken();
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
        const token = await getAccessToken();
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
