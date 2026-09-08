import { supabaseAdmin } from './supabase.js';
import { systemPrompt as defaultPrompt } from '../prompts/system.js';
import { logger } from '../middleware/logger.js';

let cachedPrompt = null;
let isCustom = false;
let lastUpdated = null;
let lastUpdatedBy = null;

const PROMPT_SETTING_KEY = 'agent_system_prompt';

/**
 * Obtiene el prompt activo del sistema.
 * Prioriza la caché en memoria; si no está cargada, consulta a Supabase.
 * Si Supabase no tiene un prompt personalizado, usa el prompt de fábrica (system.js).
 */
export async function getSystemPrompt() {
    if (cachedPrompt) {
        return cachedPrompt;
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('system_settings')
            .select('value, updated_at, updated_by')
            .eq('key', PROMPT_SETTING_KEY)
            .maybeSingle();

        if (error) {
            // Si la tabla no existe aún en Supabase, registrar aviso y usar fallback
            logger.warn('promptService: Could not read from system_settings, using defaultPrompt', { error: error.message });
            cachedPrompt = defaultPrompt;
            isCustom = false;
            return defaultPrompt;
        }

        if (data && data.value && data.value.trim().length > 0) {
            cachedPrompt = data.value;
            isCustom = true;
            lastUpdated = data.updated_at;
            lastUpdatedBy = data.updated_by;
            logger.info('promptService: Custom prompt loaded successfully from Supabase');
            return cachedPrompt;
        }
    } catch (err) {
        logger.error('promptService: Exception reading system prompt, falling back to default', err);
    }

    cachedPrompt = defaultPrompt;
    isCustom = false;
    return defaultPrompt;
}

/**
 * Retorna los detalles del prompt actual para la vista del Administrador en el CRM
 */
export async function getPromptDetails() {
    const activePrompt = await getSystemPrompt();

    return {
        prompt: activePrompt,
        is_custom: isCustom,
        default_prompt: defaultPrompt,
        updated_at: lastUpdated,
        updated_by: lastUpdatedBy
    };
}

/**
 * Guarda un nuevo prompt en Supabase y actualiza la caché en memoria en caliente
 */
export async function saveSystemPrompt(newPrompt, userEmail = 'admin') {
    if (!newPrompt || typeof newPrompt !== 'string' || newPrompt.trim().length === 0) {
        throw new Error('El prompt no puede estar vacío');
    }

    const trimmedPrompt = newPrompt.trim();
    const now = new Date().toISOString();

    const { error } = await supabaseAdmin
        .from('system_settings')
        .upsert({
            key: PROMPT_SETTING_KEY,
            value: trimmedPrompt,
            updated_at: now,
            updated_by: userEmail
        });

    if (error) {
        logger.error('promptService: Error saving prompt to Supabase', error);
        throw error;
    }

    // Registrar también en el historial de versiones (prompt_history)
    try {
        const { error: histError } = await supabaseAdmin
            .from('prompt_history')
            .insert({
                prompt: trimmedPrompt,
                created_at: now,
                created_by: userEmail
            });
        if (histError) {
            logger.warn('promptService: Could not write to prompt_history', { error: histError.message });
        }
    } catch (histErr) {
        logger.warn('promptService: Exception writing to prompt_history', histErr);
    }

    // Actualizar en caliente la memoria del servidor
    cachedPrompt = trimmedPrompt;
    isCustom = true;
    lastUpdated = now;
    lastUpdatedBy = userEmail;

    logger.info('promptService: System prompt updated in Supabase and cached in memory', { updatedBy: userEmail });

    return {
        prompt: cachedPrompt,
        is_custom: true,
        default_prompt: defaultPrompt,
        updated_at: lastUpdated,
        updated_by: lastUpdatedBy
    };
}

/**
 * Restablece el prompt a la versión de fábrica (system.js)
 */
export async function resetSystemPrompt(userEmail = 'admin') {
    logger.info('promptService: Resetting system prompt to default (system.js)');

    try {
        await supabaseAdmin
            .from('system_settings')
            .delete()
            .eq('key', PROMPT_SETTING_KEY);
    } catch (err) {
        logger.warn('promptService: Warning deleting custom prompt from DB', err);
    }

    // Registrar en el historial que se restableció a valores de fábrica
    try {
        await supabaseAdmin
            .from('prompt_history')
            .insert({
                prompt: defaultPrompt,
                created_at: new Date().toISOString(),
                created_by: `${userEmail} (Fábrica)`
            });
    } catch (histErr) {
        logger.warn('promptService: Exception writing reset to prompt_history', histErr);
    }

    cachedPrompt = defaultPrompt;
    isCustom = false;
    lastUpdated = null;
    lastUpdatedBy = null;

    return {
        prompt: defaultPrompt,
        is_custom: false,
        default_prompt: defaultPrompt,
        updated_at: null,
        updated_by: null
    };
}

/**
 * Retorna las últimas versiones registradas en el historial (por defecto las últimas 5)
 */
export async function getPromptHistory(limit = 5) {
    try {
        const { data, error } = await supabaseAdmin
            .from('prompt_history')
            .select('id, prompt, created_at, created_by')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            logger.warn('promptService: Could not fetch prompt history', { error: error.message });
            return [];
        }

        return data || [];
    } catch (err) {
        logger.error('promptService: Exception fetching prompt history', err);
        return [];
    }
}

