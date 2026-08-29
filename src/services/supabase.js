import { createClient } from '@supabase/supabase-js';
import { getSignedUrl as getFirebaseSignedUrl } from './firebase.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
// En el backend históricamente se usó SUPABASE_KEY. Permitimos también SUPABASE_ANON_KEY
// para evitar desalineaciones con documentación/front.
const supabaseAnonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;

function looksLikeJwt(value) {
    if (!value) return false;
    // Las keys de Supabase (anon/service_role) son JWT (típicamente empiezan por "eyJ" y tienen 3 partes).
    const parts = value.split('.');
    return value.startsWith('eyJ') && parts.length === 3;
}

// Avisos de configuración: no imprimimos secretos, solo una guía de corrección.
if (!supabaseUrl) {
    console.warn('[supabase] Falta SUPABASE_URL en el entorno (.env)');
}

if (!supabaseAnonKey) {
    console.warn('[supabase] Falta SUPABASE_KEY (o SUPABASE_ANON_KEY) en el entorno (.env)');
} else if (!looksLikeJwt(supabaseAnonKey) || supabaseAnonKey.length < 100) {
    console.warn('[supabase] SUPABASE_KEY/SUPABASE_ANON_KEY no parece una key válida (debe ser un JWT largo). Revisa Project Settings → API → anon public key');
}

if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!looksLikeJwt(v) || v.length < 100) {
        console.warn('[supabase] SUPABASE_SERVICE_ROLE_KEY no parece una key válida (debe ser un JWT largo). Revisa Project Settings → API → service_role key');
    }
} else {
    console.warn('[supabase] No se encontró SUPABASE_SERVICE_ROLE_KEY; se usará SUPABASE_KEY/SUPABASE_ANON_KEY como fallback (puede fallar por RLS).');
}

/**
 * Cliente de Supabase configurado con variables de entorno
 */
export const supabase = createClient(
    supabaseUrl,
    supabaseAnonKey
);

/**
 * Cliente "admin" (server-side) para operaciones de DB/Storage.
 * Si existe `SUPABASE_SERVICE_ROLE_KEY`, se usa para evitar bloqueos por RLS.
 */
export const supabaseAdmin = createClient(
    supabaseUrl,
    supabaseServiceRoleKey
);

/**
 * Obtiene un usuario existente o crea uno nuevo basado en el número de teléfono
 * Ahora soporta store_id para multi-tenant
 * @param {string} phoneNumber - Número de teléfono del usuario
 * @param {string} storeId - ID de la tienda (opcional)
 * @returns {Promise<Object>} Usuario de Supabase
 */
export async function getOrCreateUser(phoneNumber, storeId = null) {
    try {
        // Intentar encontrar usuario existente por teléfono (y tienda si se provee)
        let query = supabaseAdmin
            .from('users')
            .select('*')
            .eq('phone_number', phoneNumber);

        if (storeId) {
            query = query.eq('store_id', storeId);
        }

        const { data: existing, error: findError } = await query.maybeSingle();

        if (existing) return existing;

        // Si no existe, crear nuevo usuario
        const userData = { phone_number: phoneNumber };
        if (storeId) userData.store_id = storeId;

        const { data: newUser, error: createError } = await supabaseAdmin
            .from('users')
            .insert(userData)
            .select()
            .single();

        if (createError) throw createError;
        return newUser;
    } catch (error) {
        console.error('Error in getOrCreateUser:', error);
        throw error;
    }
}

/**
 * Obtiene el chat activo del usuario o crea uno nuevo (anteriormente getOrCreateConversation)
 * @param {string} userId - ID del usuario
 * @param {string} storeId - ID de la tienda (opcional)
 * @returns {Promise<Object>} Chat de Supabase
 */
export async function getOrCreateChat(userId, storeId = null) {
    try {
        // Buscar chat activo más reciente
        let query = supabaseAdmin
            .from('chats')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'active');

        if (storeId) {
            query = query.eq('store_id', storeId);
        }

        const { data: existing, error: findError } = await query
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (existing) {
            // Asegurar que el chat tenga registro en la tabla projects para el CRM
            try {
                const { data: proj } = await supabaseAdmin
                    .from('projects')
                    .select('id')
                    .eq('chat_id', existing.id)
                    .maybeSingle();

                if (!proj) {
                    await supabaseAdmin.from('projects').insert({
                        chat_id: existing.id,
                        estatus_embudo: existing.funnel_stage || '4 - Escribió',
                        updated_at: new Date().toISOString()
                    });
                }
            } catch (pErr) {
                console.error('Error auto-syncing project for existing chat:', pErr);
            }
            return existing;
        }

        // Crear nuevo chat
        const chatData = { user_id: userId };
        if (storeId) chatData.store_id = storeId;

        const { data: newChat, error: createError } = await supabaseAdmin
            .from('chats')
            .insert(chatData)
            .select()
            .single();

        if (createError) throw createError;

        // Crear registro inicial del proyecto en la tabla projects para el CRM
        try {
            await supabaseAdmin.from('projects').insert({
                chat_id: newChat.id,
                estatus_embudo: '4 - Escribió',
                updated_at: new Date().toISOString()
            });
        } catch (pErr) {
            console.error('Error auto-creating project for new chat:', pErr);
        }

        return newChat;
    } catch (error) {
        console.error('Error in getOrCreateChat:', error);
        throw error;
    }
}

// Mantener el nombre anterior por compatibilidad temporal si es necesario, 
// pero redirigir a la nueva función.
export const getOrCreateConversation = getOrCreateChat;

/**
 * Verifica si ya existe un mensaje con un MessageSid (Twilio) para un chat.
 * Se usa para hacer el webhook idempotente frente a reintentos.
 */
export async function hasMessageSid(chatId, messageSid) {
    if (!chatId || !messageSid) return false;

    const { data, error } = await supabaseAdmin
        .from('messages')
        .select('id')
        .eq('chat_id', chatId)
        .eq('message_sid', messageSid)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('Error checking message_sid:', error);
        return false;
    }

    return !!data;
}

/**
 * Guarda un mensaje en la base de datos
 * @param {string} chatId - ID del chat
 * @param {string} userId - ID del usuario
 * @param {string} role - Rol del mensaje (user, assistant, system)
 * @param {string} content - Contenido del mensaje
 * @param {Object} metadata - Metadata adicional
 * @returns {Promise<Object>} Mensaje guardado
 */
export async function saveMessage(chatId, userId, role, content, metadata = {}, messageSid = null) {
    try {
        const { data, error } = await supabaseAdmin
            .from('messages')
            .insert({
                chat_id: chatId, // Actualizado a chat_id (Fase 3)
                user_id: userId,
                role,
                content,
                metadata,
                message_sid: messageSid
            })
            .select()
            .single();

        if (error) throw error;

        // NOTA: La actualización de last_message_at en la tabla chats ahora se maneja
        // mediante un trigger en la base de datos (ver database/migration_v6_unread_trigger.sql).
        // No es necesario hacerlo manualmente aquí.

        return data;
    } catch (error) {
        console.error('Error in saveMessage:', error);
        throw error;
    }
}

/**
 * Obtiene el historial de mensajes de un chat
 * Adaptado para el frontend (Mapeado de campos)
 * @param {string} chatId - ID del chat
 * @param {number} limit - Límite de mensajes a recuperar
 * @returns {Promise<Array>} Array de mensajes adaptados
 */
export async function getChatHistory(chatId, limit = 50, before = null) {
    try {
        let query = supabaseAdmin
            .from('messages')
            .select('*')
            .eq('chat_id', chatId);

        // Si hay cursor (fecha), traer mensajes anteriores a esa fecha
        if (before) {
            query = query.lt('created_at', before);
        }

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        const signedUrlExpiresIn = parseInt(process.env.MEDIA_SIGNED_URL_EXPIRES_IN || '86400'); // 24h

        // Adaptar para el frontend: role -> sender_type
        const adaptedMessages = await Promise.all(data.map(async msg => {
            const adapted = {
                id: msg.id,
                chat_id: msg.chat_id,
                content: msg.content,
                sender_type: msg.role === 'user' ? 'inbound' : 'outbound',
                status: msg.status || 'sent',
                created_at: msg.created_at,
                metadata: msg.metadata || {},
                attachments: [],
                attachments_info: []
            };

            const buildProxyUrl = (originalUrl) => {
                if (!originalUrl) return null;
                return `/api/media/proxy?url=${encodeURIComponent(originalUrl)}`;
            };

            const pushAttachment = ({ url, contentType, source, storagePath, originalUrl }) => {
                if (!url) return;
                adapted.attachments.push(url);
                adapted.attachments_info.push({
                    url,
                    contentType: contentType || null,
                    source,
                    storage_path: storagePath || null,
                    original_url: originalUrl || null
                });
            };

            // Nuevo: múltiples adjuntos
            if (Array.isArray(msg.metadata?.attachments) && msg.metadata.attachments.length > 0) {
                for (const att of msg.metadata.attachments) {
                    const storagePath = att?.storage_path;
                    const originalUrl = att?.original_url;
                    const contentType = att?.content_type;

                    if (storagePath) {
                        try {
                            let signedUrl;
                            if (att.storage_provider === 'firebase') {
                                const result = await getFirebaseSignedUrl(storagePath, 7);
                                signedUrl = result.signedUrl;
                            } else {
                                signedUrl = await getSignedUrl(storagePath, signedUrlExpiresIn);
                            }

                            pushAttachment({
                                url: signedUrl,
                                contentType,
                                source: 'signed',
                                storagePath,
                                originalUrl
                            });
                            continue;
                        } catch (signedError) {
                            console.error('Error generating signed URL:', signedError);
                        }
                    }

                    // Fallback: proxy autenticado (Twilio media requiere Basic Auth en browser)
                    if (originalUrl) {
                        pushAttachment({
                            url: buildProxyUrl(originalUrl),
                            contentType,
                            source: 'proxy',
                            storagePath,
                            originalUrl
                        });
                    }
                }
            } else if (msg.metadata?.storage_path) {
                // Compatibilidad: adjunto único histórico
                const storagePath = msg.metadata.storage_path;
                const originalUrl = msg.metadata.media_url;
                const contentType = msg.metadata.content_type;

                try {
                    const signedUrl = await getSignedUrl(storagePath, signedUrlExpiresIn);
                    pushAttachment({ url: signedUrl, contentType, source: 'signed', storagePath, originalUrl });
                } catch (signedError) {
                    console.error('Error generating signed URL:', signedError);
                    if (originalUrl) {
                        pushAttachment({ url: buildProxyUrl(originalUrl), contentType, source: 'proxy', storagePath, originalUrl });
                    }
                }
            } else if (msg.metadata?.media_url) {
                // Compatibilidad: sin storage, usar proxy (mejor que Twilio URL directa)
                pushAttachment({
                    url: buildProxyUrl(msg.metadata.media_url),
                    contentType: msg.metadata.content_type,
                    source: 'proxy',
                    originalUrl: msg.metadata.media_url
                });
            }

            // Asegurar que width y height estén presentes para el front (scroll)
            if (adapted.attachments.length > 0) {
                adapted.metadata.width = msg.metadata?.width || '200px';
                adapted.metadata.height = msg.metadata?.height || 'auto';
            }

            return adapted;
        }));

        return adaptedMessages.reverse(); // Ordenar cronológicamente
    } catch (error) {
        console.error('Error in getChatHistory:', error);
        throw error;
    }
}

/**
 * Sube un archivo al bucket de Supabase Storage
 * @param {Buffer|ArrayBuffer} buffer - Contenido del archivo
 * @param {string} filename - Nombre del archivo/ruta en el bucket
 * @param {string} contentType - Tipo MIME del archivo
 * @returns {Promise<string>} Ruta del archivo en el bucket
 */
export async function uploadMedia(buffer, filename, contentType) {
    try {
        const { data, error } = await supabaseAdmin.storage
            .from('chat-media')
            .upload(filename, buffer, {
                contentType,
                upsert: true
            });

        if (error) throw error;
        return data.path;
    } catch (error) {
        console.error('Error in uploadMedia:', error);
        throw error;
    }
}

/**
 * Genera una URL firmada para un archivo en el storage
 * @param {string} path - Ruta del archivo en el bucket
 * @param {number} expiresIn - Tiempo de expiración en segundos
 * @returns {Promise<string>} URL firmada
 */
export async function getSignedUrl(path, expiresIn = 3600) {
    try {
        const { data, error } = await supabaseAdmin.storage
            .from('chat-media')
            .createSignedUrl(path, expiresIn);

        if (error) throw error;
        return data.signedUrl;
    } catch (error) {
        console.error('Error in getSignedUrl:', error);
        throw error;
    }
}

/**
 * Actualiza los datos de un usuario
 * @param {string} userId - ID del usuario
 * @param {Object} updates - Objeto con los campos a actualizar
 * @returns {Promise<Object>} Usuario actualizado
 */
export async function updateUser(userId, updates) {
    try {
        const { data, error } = await supabaseAdmin
            .from('users')
            .update(updates)
            .eq('id', userId)
            .select()
            .single();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error updating user:', error);
        throw error;
    }
}

export const getConversationHistory = getChatHistory;
