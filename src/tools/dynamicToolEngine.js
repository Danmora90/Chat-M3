import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import axios from 'axios';
import { supabaseAdmin } from '../services/supabase.js';
import { logger } from '../middleware/logger.js';

// Cache en memoria para herramientas dinámicas
let cachedCustomTools = null;
let lastCacheUpdate = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minuto de TTL automático, invalidable en caliente

/**
 * Convierte un arreglo de definiciones de parámetros JSON a un Zod Schema
 * @param {Array<Object>} parameters - [{ name, type, description, required, enum_values }]
 * @returns {z.ZodObject}
 */
export function buildZodSchema(parameters = []) {
    if (!Array.isArray(parameters) || parameters.length === 0) {
        return z.object({
            _placeholder: z.string().optional().describe("Parámetro opcional no requerido")
        });
    }

    const shape = {};

    for (const param of parameters) {
        if (!param?.name) continue;
        const name = String(param.name).trim();
        const type = (param.type || 'string').toLowerCase();
        const description = param.description || '';
        const isRequired = !!param.required;

        let fieldSchema;

        switch (type) {
            case 'number':
            case 'integer':
            case 'float':
                fieldSchema = z.number();
                break;
            case 'boolean':
                fieldSchema = z.boolean();
                break;
            case 'enum':
                if (Array.isArray(param.enum_values) && param.enum_values.length > 0) {
                    fieldSchema = z.enum(param.enum_values);
                } else {
                    fieldSchema = z.string();
                }
                break;
            case 'string':
            default:
                fieldSchema = z.string();
                break;
        }

        if (description) {
            fieldSchema = fieldSchema.describe(description);
        }

        if (!isRequired) {
            fieldSchema = fieldSchema.optional();
        }

        shape[name] = fieldSchema;
    }

    return z.object(shape);
}

/**
 * Reemplaza variables en cadenas de texto (ej: {{args.nombre}}, {{session.chat_id}})
 */
function interpolateString(template, args = {}, session = {}) {
    if (typeof template !== 'string') return template;

    return template.replace(/\{\{\s*([\w\.\-]+)\s*\}\}/g, (_, key) => {
        const parts = key.split('.');
        const scope = parts[0];
        const prop = parts.slice(1).join('.');

        if (scope === 'args' && prop) {
            return args[prop] !== undefined ? String(args[prop]) : '';
        }
        if (scope === 'session' && prop) {
            return session[prop] !== undefined ? String(session[prop]) : '';
        }
        if (scope === 'now') {
            return new Date().toISOString();
        }
        // Fallback directo a args
        if (args[key] !== undefined) {
            return String(args[key]);
        }
        return '';
    });
}

/**
 * Resuelve recursivamente valores y objetos con interpolación
 */
function interpolateObject(obj, args = {}, session = {}) {
    if (!obj || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            const trimmed = obj.trim();
            // Si es un valor exacto de reemplazo booleano o numérico
            if (trimmed === '{{session.chat_id}}') return session.chat_id;
            if (trimmed === '{{session.user_id}}') return session.user_id;
            return interpolateString(obj, args, session);
        }
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => interpolateObject(item, args, session));
    }

    const result = {};
    for (const [k, v] of Object.entries(obj)) {
        result[k] = interpolateObject(v, args, session);
    }
    return result;
}

/**
 * Ejecutor para Tools de tipo Database Action
 */
async function executeDatabaseAction(config = {}, args = {}, session = {}) {
    const table = config.table || 'chats';
    const action = (config.action || 'update').toLowerCase();
    const target = config.target || 'current_chat';
    const rawFields = config.field_mappings || {};

    const fields = interpolateObject(rawFields, args, session);
    fields.updated_at = new Date().toISOString();

    logger.info('DynamicTool: Executing database action', {
        table,
        action,
        target,
        session
    });

    if (action === 'update') {
        let query = supabaseAdmin.from(table).update(fields);

        if (target === 'current_chat' && session.chat_id) {
            query = query.eq('id', session.chat_id);
        } else if (target === 'current_user' && session.user_id) {
            query = query.eq('id', session.user_id);
        } else if (config.filter_column && config.filter_value) {
            const filterVal = interpolateString(config.filter_value, args, session);
            query = query.eq(config.filter_column, filterVal);
        } else if (session.chat_id) {
            query = query.eq('id', session.chat_id);
        } else {
            throw new Error(`No se pudo determinar el registro objetivo para actualizar en la tabla ${table}.`);
        }

        const { data, error } = await query.select();
        if (error) throw error;

        const customMsg = config.success_message 
            ? interpolateString(config.success_message, args, session)
            : `✅ Acción de base de datos ejecutada con éxito en ${table}.`;

        return `${customMsg} (Registros actualizados: ${data?.length || 1})`;
    } else if (action === 'insert') {
        if (target === 'current_chat' && session.chat_id && !fields.chat_id && table !== 'chats') {
            fields.chat_id = session.chat_id;
        }
        if (target === 'current_user' && session.user_id && !fields.user_id && table !== 'users') {
            fields.user_id = session.user_id;
        }

        const { data, error } = await supabaseAdmin.from(table).insert(fields).select();
        if (error) throw error;

        const customMsg = config.success_message 
            ? interpolateString(config.success_message, args, session)
            : `✅ Nuevo registro creado exitosamente en ${table}.`;

        return `${customMsg} (ID: ${data?.[0]?.id || 'creado'})`;
    } else {
        throw new Error(`Acción de base de datos no soportada: ${action}`);
    }
}

/**
 * Ejecutor para Tools de tipo HTTP Request
 */
async function executeHttpRequest(config = {}, args = {}, session = {}) {
    const rawUrl = config.url;
    if (!rawUrl) throw new Error("La URL de la tool HTTP es requerida.");

    const url = interpolateString(rawUrl, args, session);
    const method = (config.method || 'POST').toUpperCase();
    const rawHeaders = config.headers || {};
    const headers = interpolateObject(rawHeaders, args, session);

    let data = undefined;

    if (method !== 'GET') {
        if (config.body_template && typeof config.body_template === 'string') {
            const rendered = interpolateString(config.body_template, args, session);
            try {
                data = JSON.parse(rendered);
            } catch (e) {
                data = rendered; // Fallback a texto plano si no es JSON válido
            }
        } else if (config.body && typeof config.body === 'object') {
            data = interpolateObject(config.body, args, session);
        } else {
            // Por defecto enviar los argumentos de la tool
            data = { ...args, session };
        }
    }

    logger.info('DynamicTool: Sending HTTP request', {
        method,
        url,
        hasData: !!data
    });

    const response = await axios({
        method,
        url,
        headers,
        data,
        timeout: 15000,
        validateStatus: () => true // No lanzar en 4xx/5xx para inspeccionar respuesta
    });

    if (response.status >= 200 && response.status < 300) {
        const customMsg = config.success_message 
            ? interpolateString(config.success_message, args, session)
            : `✅ Solicitud HTTP completada exitosamente (Código ${response.status}).`;

        let details = '';
        if (typeof response.data === 'object') {
            try {
                details = JSON.stringify(response.data);
            } catch (_) {}
        } else if (typeof response.data === 'string') {
            details = response.data.slice(0, 500);
        }

        return `${customMsg} Respuesta: ${details || 'OK'}`;
    } else {
        const errorText = typeof response.data === 'object' 
            ? JSON.stringify(response.data) 
            : String(response.data);
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }
}

/**
 * Convierte un registro de custom_tools a una instancia ejecutable de LangChain
 * @param {Object} toolRecord - Registro de la tabla custom_tools
 * @returns {Object} Instancia de LangChain tool
 */
export function createDynamicTool(toolRecord) {
    const { name, display_name, description, tool_type, parameters, execution_config } = toolRecord;

    const schema = buildZodSchema(parameters);

    return tool(
        async (args, config) => {
            const startTime = Date.now();
            try {
                // Resolver contexto de la sesión actual
                const threadId = config?.configurable?.thread_id;
                let chatId = null;
                let userId = null;
                let customerPhone = null;

                if (threadId) {
                    chatId = threadId.replace('conversation_', '');
                    try {
                        const { data: chatData } = await supabaseAdmin
                            .from('chats')
                            .select('id, user_id, customer_phone, users(id, phone_number, display_name)')
                            .eq('id', chatId)
                            .maybeSingle();

                        if (chatData) {
                            userId = chatData.user_id || chatData.users?.id;
                            customerPhone = chatData.customer_phone || chatData.users?.phone_number;
                        }
                    } catch (err) {
                        logger.warn('DynamicTool: Error resolving session details', { error: err.message, chatId });
                    }
                }

                const session = {
                    chat_id: chatId,
                    user_id: userId,
                    customer_phone: customerPhone
                };

                logger.info(`DynamicTool: Invoking tool "${name}"`, { args, session });

                let resultText = '';

                if (tool_type === 'database_action') {
                    resultText = await executeDatabaseAction(execution_config, args, session);
                } else if (tool_type === 'http_request') {
                    resultText = await executeHttpRequest(execution_config, args, session);
                } else {
                    throw new Error(`Tipo de herramienta desconocido: ${tool_type}`);
                }

                const duration = Date.now() - startTime;
                logger.info(`DynamicTool: Tool "${name}" executed successfully in ${duration}ms`);
                return resultText;
            } catch (error) {
                const duration = Date.now() - startTime;
                logger.error(`DynamicTool: Tool "${name}" execution failed (${duration}ms)`, {
                    error: error.message
                });
                return `❌ Error al ejecutar ${display_name || name}: ${error.message}`;
            }
        },
        {
            name: String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            description: String(description || '').trim(),
            schema
        }
    );
}

/**
 * Obtiene todas las tools dinámicas activas desde Supabase (con caché en memoria)
 * @param {boolean} forceRefresh - Forzar consulta fresca a la BD
 * @returns {Promise<Array<Object>>} Lista de tools ejecutables de LangChain
 */
export async function getActiveDynamicTools(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && cachedCustomTools && (now - lastCacheUpdate) < CACHE_TTL_MS) {
        return cachedCustomTools;
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('custom_tools')
            .select('*')
            .eq('is_active', true)
            .order('created_at', { ascending: true });

        if (error) {
            if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
                // La tabla custom_tools aún no se ha creado en Supabase
                cachedCustomTools = [];
                lastCacheUpdate = now;
                return [];
            }
            logger.error('DynamicTool: Error querying custom_tools table', error);
            return cachedCustomTools || [];
        }

        const compiledTools = (data || []).map(record => {
            try {
                return createDynamicTool(record);
            } catch (err) {
                logger.error(`DynamicTool: Failed to compile tool ${record.name}`, err);
                return null;
            }
        }).filter(Boolean);

        cachedCustomTools = compiledTools;
        lastCacheUpdate = now;

        logger.info(`DynamicTool: Loaded ${compiledTools.length} active custom tools from Supabase`);
        return compiledTools;
    } catch (err) {
        logger.error('DynamicTool: Unexpected error fetching custom tools', err);
        return cachedCustomTools || [];
    }
}

/**
 * Invalida el caché en memoria para que los cambios en el panel surtan efecto inmediato
 */
export function invalidateCustomToolsCache() {
    cachedCustomTools = null;
    lastCacheUpdate = 0;
    logger.info('DynamicTool: Cache invalidated');
}

/**
 * Ejecución de prueba aislada para el Test Runner del panel de administración
 * @param {Object} toolRecord - Definición de la tool
 * @param {Object} sampleArgs - Argumentos simulados
 * @param {Object} [mockSession] - Contexto de prueba (opcional)
 */
export async function testExecuteCustomTool(toolRecord, sampleArgs = {}, mockSession = {}) {
    const startTime = Date.now();

    const session = {
        chat_id: mockSession.chat_id || 'test-chat-uuid',
        user_id: mockSession.user_id || 'test-user-uuid',
        customer_phone: mockSession.customer_phone || '+573001234567'
    };

    try {
        const { tool_type, execution_config } = toolRecord;

        let output = '';
        if (tool_type === 'database_action') {
            output = await executeDatabaseAction(execution_config, sampleArgs, session);
        } else if (tool_type === 'http_request') {
            output = await executeHttpRequest(execution_config, sampleArgs, session);
        } else {
            throw new Error(`Tipo de herramienta desconocido: ${tool_type}`);
        }

        return {
            success: true,
            output,
            durationMs: Date.now() - startTime
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            durationMs: Date.now() - startTime
        };
    }
}
