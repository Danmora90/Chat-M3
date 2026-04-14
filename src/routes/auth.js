import express from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

/**
 * GET /auth/me
 * Obtiene información del usuario autenticado (requerido por el frontend)
 * Requiere: JWT válido
 */
router.get('/me', authMiddleware, catchAsync(async (req, res) => {
    logger.info('Auth: User info requested via /auth/me', { userId: req.userId });

    res.json({
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.full_name,
        role: (req.user.role || 'user').toUpperCase(),
        store_id: req.user.store_id,
        avatar_url: req.user.avatar_url,
        ...req.user // Incluir metadatos adicionales si existen
    });
}));

export default router;
