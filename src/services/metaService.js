import axios from 'axios';
import { logger } from '../middleware/logger.js';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

let cachedResolvedToken = null;
let lastResolvedAt = 0;

/**
 * Obtiene el Page Access Token configurado.
 * 1. Si es un System User Token, obtiene el Page Access Token de MAS.3 vía /{pageId}?fields=access_token
 * 2. Si es un User Token estándar, lo busca vía /me/accounts
 * 3. Si ya es un Page Access Token directo, lo usa tal cual
 */
export async function getAccessToken() {
    const rawToken = (process.env.META_PAGE_ACCESS_TOKEN || '').trim().replace(/^["']|["']$/g, '');
    if (!rawToken) {
        throw new Error('META_PAGE_ACCESS_TOKEN no está configurado en las variables de entorno.');
    }

    // Cache por 1 hora para evitar llamadas repetitivas
    if (cachedResolvedToken && (Date.now() - lastResolvedAt < 3600 * 1000)) {
        return cachedResolvedToken;
    }

    const targetPageId = (process.env.META_PAGE_ID || '163693413486965').trim();

    // 1. Método oficial para System User Tokens asignados a la página: /{pageId}?fields=access_token
    try {
        const pageRes = await axios.get(`${GRAPH_API_BASE}/${targetPageId}`, {
            params: {
                fields: 'access_token,name',
                access_token: rawToken
            },
            timeout: 7000
        });

        if (pageRes.data?.access_token) {
            logger.info('Auto-resolved Page Access Token from /{pageId}', {
                pageId: targetPageId,
                name: pageRes.data.name
            });
            cachedResolvedToken = pageRes.data.access_token.trim();
            lastResolvedAt = Date.now();
            return cachedResolvedToken;
        }
    } catch (pageErr) {
        logger.warn('Direct /{pageId} token resolution not applicable or failed', {
            error: pageErr.response?.data?.error?.message || pageErr.message
        });
    }

    // 2. Método alternativo para System User Tokens de Business Manager: /{business_id}/owned_pages
    const businessId = (process.env.META_BUSINESS_ID || '538532327414599').trim();
    try {
        const bizRes = await axios.get(`${GRAPH_API_BASE}/${businessId}/owned_pages`, {
            params: {
                fields: 'access_token,name,id',
                access_token: rawToken
            },
            timeout: 7000
        });

        const pages = bizRes.data?.data || [];
        const match = pages.find(p => p.id === targetPageId) || pages[0];
        if (match?.access_token) {
            logger.info('Auto-resolved Page Access Token from /{business_id}/owned_pages', {
                pageId: match.id,
                name: match.name
            });
            cachedResolvedToken = match.access_token.trim();
            lastResolvedAt = Date.now();
            return cachedResolvedToken;
        }
    } catch (bizErr) {
        // Silencioso
    }

    // 3. Método para User Tokens personales: /me/accounts
    try {
        const accountsRes = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
            params: { access_token: rawToken },
            timeout: 7000
        });

        const pages = accountsRes.data?.data || [];
        const targetPage = pages.find(p => p.id === targetPageId) || pages[0];

        if (targetPage?.access_token) {
            logger.info('Auto-resolved Page Access Token from /me/accounts', {
                pageId: targetPage.id,
                name: targetPage.name
            });
            cachedResolvedToken = targetPage.access_token.trim();
            lastResolvedAt = Date.now();
            return cachedResolvedToken;
        }
    } catch (err) {
        // Silencioso
    }

    // 4. Fallback: Usar rawToken (asumiendo que ya es un Page Access Token directo)
    cachedResolvedToken = rawToken;
    lastResolvedAt = Date.now();
    return rawToken;
}

/**
 * Consulta los detalles de un comentario público directamente en Meta Graph API
 * Útil cuando el webhook de Facebook/Instagram no incluye el texto (videos, reels, anuncios)
 * @param {string} commentId - ID del comentario
 * @param {string} [platform='facebook'] - Plataforma ('facebook' o 'instagram')
 * @returns {Promise<Object|null>} Datos del comentario con campos normalizados
 */
export async function fetchCommentDetails(commentId, platform = 'facebook') {
    try {
        const token = await getAccessToken();
        const fields = platform === 'instagram'
            ? 'text,from,timestamp,username'
            : 'message,from,created_time';

        const response = await axios.get(`${GRAPH_API_BASE}/${commentId}`, {
            params: {
                fields,
                access_token: token
            },
            timeout: 5000
        });

        const data = response.data || {};
        return {
            message: data.text || data.message || '',
            text: data.text || data.message || '',
            from: data.from,
            raw: data
        };
    } catch (err) {
        logger.warn('Could not fetch comment details from Graph API', {
            commentId,
            platform,
            error: err.response?.data?.error?.message || err.message
        });
        return null;
    }
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
            { message: text, access_token: token },
            {
                params: { access_token: token },
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
                params: { access_token: token },
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
