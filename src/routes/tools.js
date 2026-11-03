import express from 'express';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { supabaseAdmin } from '../services/supabase.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';
import { 
    invalidateCustomToolsCache, 
    testExecuteCustomTool 
} from '../tools/dynamicToolEngine.js';
import { resetAgentInstance } from '../agent/graph.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * Normaliza nombres técnicos de tools para cumplir con OpenAI y LangChain
 */
function sanitizeToolName(name) {
    if (!name) return '';
    return String(name)
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar tildes
        .replace(/[^a-z0-9_]/g, '_') // Solo letras, números y guión bajo
        .replace(/_+/g, '_')
        .slice(0, 64);
}

/**
 * GET /api/admin/tools
 * Lista todas las herramientas dinámicas configuradas
 */
router.get('/', catchAsync(async (req, res) => {
    logger.info('Admin: Listing custom tools', { adminId: req.user.id });

    const { data: tools, error } = await supabaseAdmin
        .from('custom_tools')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
            return res.status(503).json({
                success: false,
                code: 'TABLES_NOT_FOUND',
                error: 'Falta ejecutar la migración SQL en Supabase para crear la tabla custom_tools.'
            });
        }
        throw error;
    }

    res.json({
        success: true,
        tools: tools || []
    });
}));

/**
 * POST /api/admin/tools
 * Crea una nueva herramienta dinámica
 */
router.post('/', catchAsync(async (req, res) => {
    const { 
        name, 
        display_name, 
        description, 
        tool_type = 'database_action', 
        parameters = [], 
        execution_config = {}, 
        is_active = true 
    } = req.body;

    const sanitizedName = sanitizeToolName(name);

    if (!sanitizedName || sanitizedName.length < 2) {
        return res.status(400).json({ 
            error: 'El nombre técnico de la herramienta es requerido (mínimo 2 caracteres, solo letras, números y guiones bajos)' 
        });
    }

    if (!description || description.trim().length < 5) {
        return res.status(400).json({ 
            error: 'La descripción para el modelo de IA es requerida (mínimo 5 caracteres para que el modelo sepa cuándo usarla)' 
        });
    }

    if (!['database_action', 'http_request'].includes(tool_type)) {
        return res.status(400).json({ 
            error: 'Tipo de herramienta inválido. Debe ser database_action o http_request.' 
        });
    }

    logger.info('Admin: Creating custom tool', { 
        adminId: req.user.id, 
        name: sanitizedName, 
        tool_type 
    });

    // Validar unicidad del nombre
    const { data: existing } = await supabaseAdmin
        .from('custom_tools')
        .select('id')
        .eq('name', sanitizedName)
        .maybeSingle();

    if (existing) {
        return res.status(400).json({ 
            error: `Ya existe una herramienta registrada con el nombre "${sanitizedName}". Elige un nombre técnico distinto.` 
        });
    }

    const { data: newTool, error } = await supabaseAdmin
        .from('custom_tools')
        .insert({
            name: sanitizedName,
            display_name: display_name?.trim() || sanitizedName,
            description: description.trim(),
            tool_type,
            parameters: Array.isArray(parameters) ? parameters : [],
            execution_config: typeof execution_config === 'object' ? execution_config : {},
            is_active: is_active ?? true,
            created_by: req.user.id,
            updated_at: new Date().toISOString()
        })
        .select()
        .single();

    if (error) {
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
            return res.status(503).json({
                success: false,
                code: 'TABLES_NOT_FOUND',
                error: 'Falta ejecutar la migración SQL en Supabase para crear la tabla custom_tools.'
            });
        }
        throw error;
    }

    // Invalidar caché y reiniciar agente para aplicar cambios de inmediato
    invalidateCustomToolsCache();
    resetAgentInstance();

    res.status(201).json({
        success: true,
        tool: newTool
    });
}));

/**
 * GET /api/admin/tools/:id
 * Obtiene el detalle de una herramienta
 */
router.get('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;

    const { data: tool, error } = await supabaseAdmin
        .from('custom_tools')
        .select('*')
        .eq('id', id)
        .single();

    if (error) throw error;
    if (!tool) {
        return res.status(404).json({ error: 'Herramienta no encontrada' });
    }

    res.json({
        success: true,
        tool
    });
}));

/**
 * PUT /api/admin/tools/:id
 * Actualiza una herramienta existente
 */
router.put('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    const { 
        name, 
        display_name, 
        description, 
        tool_type, 
        parameters, 
        execution_config, 
        is_active 
    } = req.body;

    logger.info('Admin: Updating custom tool', { adminId: req.user.id, toolId: id });

    const updatePayload = {
        updated_at: new Date().toISOString()
    };

    if (name !== undefined) {
        const sanitized = sanitizeToolName(name);
        if (sanitized.length < 2) {
            return res.status(400).json({ error: 'El nombre técnico debe tener al menos 2 caracteres válidos.' });
        }
        updatePayload.name = sanitized;
    }

    if (display_name !== undefined) updatePayload.display_name = display_name.trim();
    if (description !== undefined) updatePayload.description = description.trim();
    if (tool_type !== undefined) updatePayload.tool_type = tool_type;
    if (parameters !== undefined) updatePayload.parameters = Array.isArray(parameters) ? parameters : [];
    if (execution_config !== undefined) updatePayload.execution_config = execution_config;
    if (is_active !== undefined) updatePayload.is_active = !!is_active;

    const { data: updated, error } = await supabaseAdmin
        .from('custom_tools')
        .update(updatePayload)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;

    // Invalidar caché y reiniciar agente
    invalidateCustomToolsCache();
    resetAgentInstance();

    res.json({
        success: true,
        tool: updated
    });
}));

/**
 * DELETE /api/admin/tools/:id
 * Elimina una herramienta dinámica
 */
router.delete('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    logger.info('Admin: Deleting custom tool', { adminId: req.user.id, toolId: id });

    const { error } = await supabaseAdmin
        .from('custom_tools')
        .delete()
        .eq('id', id);

    if (error) throw error;

    // Invalidar caché y reiniciar agente
    invalidateCustomToolsCache();
    resetAgentInstance();

    res.json({
        success: true,
        message: 'Herramienta eliminada correctamente'
    });
}));

/**
 * POST /api/admin/tools/:id/test
 * Prueba en vivo de una herramienta existente o borrador
 */
router.post('/:id/test', catchAsync(async (req, res) => {
    const { id } = req.params;
    const { sample_args = {}, mock_session = {}, draft_tool = null } = req.body;

    let targetTool = draft_tool;

    if (!targetTool && id !== 'draft') {
        const { data: dbTool, error } = await supabaseAdmin
            .from('custom_tools')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        targetTool = dbTool;
    }

    if (!targetTool) {
        return res.status(400).json({ error: 'No se suministró una herramienta para probar' });
    }

    logger.info('Admin: Testing custom tool execution', { 
        adminId: req.user.id, 
        toolName: targetTool.name,
        sampleArgs: sample_args 
    });

    const result = await testExecuteCustomTool(targetTool, sample_args, mock_session);

    res.json({
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs
    });
}));

export default router;
