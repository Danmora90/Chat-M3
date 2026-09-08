import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /api/notifications
 * Obtiene las notificaciones del usuario en sesión y el conteo de no leídas
 */
router.get('/', catchAsync(async (req, res) => {
    const userId = req.user.id;

    const { data: notifications, error } = await supabaseAdmin
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(25);

    if (error) {
        logger.warn('Notifications: Warning querying notifications', { error: error.message });
        return res.json({ notifications: [], unread_count: 0 });
    }

    const unreadCount = (notifications || []).filter(n => !n.is_read).length;

    res.json({
        notifications: notifications || [],
        unread_count: unreadCount
    });
}));

/**
 * PUT /api/notifications/:id/read
 * Marca una notificación específica como leída
 */
router.put('/:id/read', catchAsync(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

    if (error) {
        logger.error('Notifications: Error marking notification as read', error);
        throw error;
    }

    res.json(data);
}));

/**
 * PUT /api/notifications/read-all
 * Marca todas las notificaciones del usuario como leídas
 */
router.put('/read-all', catchAsync(async (req, res) => {
    const userId = req.user.id;

    const { error } = await supabaseAdmin
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('is_read', false);

    if (error) {
        logger.error('Notifications: Error marking all notifications as read', error);
        throw error;
    }

    res.json({ success: true, message: 'Todas las notificaciones marcadas como leídas' });
}));

export default router;
