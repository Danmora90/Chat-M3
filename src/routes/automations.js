import express from 'express';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { supabaseAdmin } from '../services/supabase.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * GET /api/admin/automations
 * Lista todos los flujos configurados con métricas de ejecuciones
 */
router.get('/', catchAsync(async (req, res) => {
    logger.info('Admin: Listing automation flows', { adminId: req.user.id });

    const { data: flows, error } = await supabaseAdmin
        .from('automation_flows')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
            return res.status(503).json({
                success: false,
                code: 'TABLES_NOT_FOUND',
                error: 'Falta ejecutar la migración SQL en Supabase para crear las tablas de automatizaciones (automation_flows y automation_queue).'
            });
        }
        throw error;
    }

    // Obtener recuento de tareas por flujo
    const flowIds = (flows || []).map(f => f.id);
    let queueStats = {};

    if (flowIds.length > 0) {
        const { data: queueCounts } = await supabaseAdmin
            .from('automation_queue')
            .select('flow_id, status')
            .in('flow_id', flowIds);

        if (queueCounts) {
            for (const item of queueCounts) {
                if (!queueStats[item.flow_id]) {
                    queueStats[item.flow_id] = { pending: 0, completed: 0, cancelled: 0, failed: 0 };
                }
                queueStats[item.flow_id][item.status] = (queueStats[item.flow_id][item.status] || 0) + 1;
            }
        }
    }

    const enriched = (flows || []).map(f => ({
        ...f,
        stats: queueStats[f.id] || { pending: 0, completed: 0, cancelled: 0, failed: 0 }
    }));

    res.json({
        success: true,
        flows: enriched
    });
}));

/**
 * POST /api/admin/automations
 * Crea un nuevo flujo de automatización
 */
router.post('/', catchAsync(async (req, res) => {
    const { name, description, trigger_type, trigger_stage, inactivity_minutes, steps, is_active } = req.body;

    if (!name || !trigger_type) {
        return res.status(400).json({ error: 'Nombre y tipo de disparador son requeridos' });
    }

    logger.info('Admin: Creating automation flow', { adminId: req.user.id, name, trigger_type });

    const storeId = process.env.STORE_ID || null;

    const { data: newFlow, error } = await supabaseAdmin
        .from('automation_flows')
        .insert({
            name,
            description: description || null,
            trigger_type,
            trigger_stage: trigger_type === 'stage_change' ? trigger_stage : null,
            inactivity_minutes: trigger_type === 'inactivity' ? (inactivity_minutes || 5) : null,
            is_active: is_active ?? true,
            steps: Array.isArray(steps) ? steps : [],
            store_id: storeId,
            updated_at: new Date().toISOString()
        })
        .select()
        .single();

    if (error) throw error;

    res.status(201).json({
        success: true,
        flow: newFlow
    });
}));

/**
 * PUT /api/admin/automations/:id
 * Actualiza un flujo (pasos, estado activo, nombre, etc.)
 */
router.put('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    const { name, description, trigger_type, trigger_stage, inactivity_minutes, steps, is_active } = req.body;

    logger.info('Admin: Updating automation flow', { adminId: req.user.id, flowId: id });

    const updatePayload = {
        updated_at: new Date().toISOString()
    };

    if (name !== undefined) updatePayload.name = name;
    if (description !== undefined) updatePayload.description = description;
    if (trigger_type !== undefined) updatePayload.trigger_type = trigger_type;
    if (trigger_stage !== undefined) updatePayload.trigger_stage = trigger_stage;
    if (inactivity_minutes !== undefined) updatePayload.inactivity_minutes = inactivity_minutes;
    if (steps !== undefined) updatePayload.steps = steps;
    if (is_active !== undefined) updatePayload.is_active = is_active;

    const { data: updated, error } = await supabaseAdmin
        .from('automation_flows')
        .update(updatePayload)
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;

    res.json({
        success: true,
        flow: updated
    });
}));

/**
 * DELETE /api/admin/automations/:id
 * Elimina un flujo y cancela sus tareas en cola
 */
router.delete('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    logger.info('Admin: Deleting automation flow', { adminId: req.user.id, flowId: id });

    const { error } = await supabaseAdmin
        .from('automation_flows')
        .delete()
        .eq('id', id);

    if (error) throw error;

    res.json({
        success: true,
        message: 'Flujo eliminado correctamente'
    });
}));

/**
 * GET /api/admin/automations/queue
 * Consulta las tareas en cola y registros recientes
 */
router.get('/queue', catchAsync(async (req, res) => {
    const { limit = 50, status } = req.query;

    let query = supabaseAdmin
        .from('automation_queue')
        .select(`
            *,
            automation_flows(name, trigger_type, trigger_stage),
            chats(id, customer_phone, funnel_stage, users(display_name, phone_number))
        `)
        .order('created_at', { ascending: false })
        .limit(parseInt(limit, 10));

    if (status) {
        query = query.eq('status', status);
    }

    const { data: queue, error } = await query;
    if (error) {
        if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
            return res.status(503).json({
                success: false,
                code: 'TABLES_NOT_FOUND',
                error: 'Falta ejecutar la migración SQL en Supabase para crear las tablas de automatizaciones.'
            });
        }
        throw error;
    }

    res.json({
        success: true,
        queue: queue || []
    });
}));

export default router;
