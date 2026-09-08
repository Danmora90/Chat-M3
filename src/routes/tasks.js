import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /api/tasks/team
 * Lista de integrantes del equipo disponible para todos los miembros autenticados
 */
router.get('/team', catchAsync(async (req, res) => {
    const { data: team, error } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email, avatar_url, role')
        .order('full_name', { ascending: true });

    if (error) {
        logger.warn('Tasks: Warning fetching team profiles', error);
        return res.json([]);
    }

    res.json(team || []);
}));

/**
 * GET /api/tasks
 * Obtiene la lista de tareas del equipo, enriquecida con información de perfiles
 */
router.get('/', catchAsync(async (req, res) => {
    logger.info('Tasks: List requested', { userId: req.user.id, role: req.user.role });

    const { status, assigned_to, priority } = req.query;

    let query = supabaseAdmin
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status.toUpperCase());
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
    if (priority) query = query.eq('priority', priority.toUpperCase());

    const { data: tasks, error } = await query;

    if (error) {
        // Si la tabla no existe aún, retornar array vacío
        logger.warn('Tasks: Warning querying tasks table', { error: error.message });
        return res.json([]);
    }

    if (!tasks || tasks.length === 0) {
        return res.json([]);
    }

    // Obtener información de perfiles para creadores y asignados
    const profileIds = [...new Set(
        tasks.map(t => t.assigned_to).concat(tasks.map(t => t.created_by)).filter(Boolean)
    )];

    let profilesMap = {};
    if (profileIds.length > 0) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, email, avatar_url, role')
            .in('id', profileIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {});
        }
    }

    const enrichedTasks = tasks.map(t => ({
        ...t,
        assigned_user: t.assigned_to ? (profilesMap[t.assigned_to] || { id: t.assigned_to, full_name: 'Usuario' }) : null,
        creator: t.created_by ? (profilesMap[t.created_by] || { id: t.created_by, full_name: 'Admin' }) : null
    }));

    res.json(enrichedTasks);
}));

/**
 * POST /api/tasks
 * Crea una nueva tarea y notifica al usuario asignado (Solo ADMIN)
 */
router.post('/', catchAsync(async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Solo los administradores pueden crear tareas' });
    }

    const { title, description, assigned_to, due_date, priority, status } = req.body;

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'El título de la tarea es obligatorio' });
    }

    const now = new Date().toISOString();
    const taskPayload = {
        title: title.trim(),
        description: description ? description.trim() : '',
        assigned_to: assigned_to || null,
        created_by: req.user.id,
        due_date: due_date || null,
        priority: (priority || 'MEDIA').toUpperCase(),
        status: (status || 'PENDIENTE').toUpperCase(),
        created_at: now,
        updated_at: now
    };

    const { data: newTask, error } = await supabaseAdmin
        .from('tasks')
        .insert(taskPayload)
        .select()
        .single();

    if (error) {
        logger.error('Tasks: Error creating task in Supabase', error);
        throw error;
    }

    // Si la tarea fue asignada a un integrante, generar notificación
    if (assigned_to) {
        try {
            const formattedDate = due_date ? new Date(due_date).toLocaleDateString('es-CO', {
                year: 'numeric', month: 'short', day: 'numeric'
            }) : 'Sin fecha límite';

            await supabaseAdmin
                .from('notifications')
                .insert({
                    user_id: assigned_to,
                    title: 'Nueva tarea asignada',
                    message: `${req.user.full_name || 'El Administrador'} te ha asignado la tarea: "${newTask.title}". Fecha de entrega: ${formattedDate}.`,
                    type: 'TASK_ASSIGNED',
                    link: `/tasks?id=${newTask.id}`,
                    is_read: false,
                    created_at: now
                });
            logger.info('Tasks: Notification sent to assigned user', { userId: assigned_to, taskId: newTask.id });
        } catch (notifErr) {
            logger.warn('Tasks: Warning creating notification', notifErr);
        }
    }

    res.status(201).json(newTask);
}));

/**
 * PUT /api/tasks/:id
 * Actualiza una tarea existente
 * - ADMIN: puede actualizar cualquier campo
 * - Integrante asignado: puede actualizar el estatus de su tarea
 */
router.put('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    const { title, description, assigned_to, due_date, priority, status } = req.body;

    const { data: existingTask, error: fetchErr } = await supabaseAdmin
        .from('tasks')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (fetchErr || !existingTask) {
        return res.status(404).json({ error: 'La tarea no existe' });
    }

    const isAdmin = req.user.role === 'ADMIN';
    const isAssigned = existingTask.assigned_to === req.user.id;

    if (!isAdmin && !isAssigned) {
        return res.status(403).json({ error: 'No tienes permiso para modificar esta tarea' });
    }

    const now = new Date().toISOString();
    let updates = { updated_at: now };

    if (isAdmin) {
        if (title !== undefined) updates.title = title.trim();
        if (description !== undefined) updates.description = description.trim();
        if (assigned_to !== undefined) updates.assigned_to = assigned_to || null;
        if (due_date !== undefined) updates.due_date = due_date || null;
        if (priority !== undefined) updates.priority = priority.toUpperCase();
        if (status !== undefined) updates.status = status.toUpperCase();
    } else {
        // El usuario solo puede modificar el estatus de su propia tarea
        if (status !== undefined) {
            updates.status = status.toUpperCase();
        }
    }

    const { data: updatedTask, error: updateErr } = await supabaseAdmin
        .from('tasks')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (updateErr) {
        logger.error('Tasks: Error updating task', updateErr);
        throw updateErr;
    }

    // Notificaciones según cambios relevantes:
    // 1. Si el admin reasignó la tarea a un usuario nuevo
    if (isAdmin && assigned_to && assigned_to !== existingTask.assigned_to) {
        try {
            await supabaseAdmin.from('notifications').insert({
                user_id: assigned_to,
                title: 'Tarea asignada',
                message: `${req.user.full_name || 'El Administrador'} te ha asignado la tarea: "${updatedTask.title}".`,
                type: 'TASK_ASSIGNED',
                link: `/tasks?id=${updatedTask.id}`,
                is_read: false,
                created_at: now
            });
        } catch (e) {
            logger.warn('Tasks: Warning sending reassignment notification', e);
        }
    }

    // 2. Si un integrante completó la tarea, notificar al creador/admin
    if (!isAdmin && updates.status === 'COMPLETADA' && existingTask.created_by) {
        try {
            await supabaseAdmin.from('notifications').insert({
                user_id: existingTask.created_by,
                title: 'Tarea completada',
                message: `${req.user.full_name || 'Un colaborador'} ha marcado como completada la tarea: "${updatedTask.title}".`,
                type: 'TASK_UPDATED',
                link: `/tasks?id=${updatedTask.id}`,
                is_read: false,
                created_at: now
            });
        } catch (e) {
            logger.warn('Tasks: Warning sending completion notification', e);
        }
    }

    res.json(updatedTask);
}));

/**
 * DELETE /api/tasks/:id
 * Elimina una tarea (Solo ADMIN)
 */
router.delete('/:id', catchAsync(async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Solo los administradores pueden eliminar tareas' });
    }

    const { id } = req.params;
    const { error } = await supabaseAdmin
        .from('tasks')
        .delete()
        .eq('id', id);

    if (error) {
        logger.error('Tasks: Error deleting task', error);
        throw error;
    }

    res.json({ success: true, message: 'Tarea eliminada exitosamente' });
}));

export default router;
