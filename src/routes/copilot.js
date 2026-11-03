import express from 'express';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { adminCopilotService } from '../services/adminCopilotService.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

// Todas las rutas del Copilot requieren autenticación y rol ADMIN
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * POST /api/admin/copilot/chat
 * Procesa un turno de conversación del administrador con el Copilot
 */
router.post('/chat', catchAsync(async (req, res) => {
    const { message, sessionId: customSessionId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'El mensaje es requerido' });
    }

    const sessionId = customSessionId || `admin_web_${req.user.id}`;
    const adminContext = {
        adminId: req.user.id,
        adminEmail: req.user.email,
        adminRole: req.user.role,
        source: 'web'
    };

    logger.info('AdminCopilot: Web chat request received', {
        adminId: req.user.id,
        sessionId,
        messagePreview: message.slice(0, 80)
    });

    const result = await adminCopilotService.chat({
        sessionId,
        message,
        adminContext
    });

    res.json({
        success: true,
        reply: result.reply,
        executedTools: result.executedTools,
        sessionId: result.sessionId
    });
}));

/**
 * GET /api/admin/copilot/history
 * Obtiene el historial de conversación del administrador
 */
router.get('/history', catchAsync(async (req, res) => {
    const sessionId = req.query.sessionId || `admin_web_${req.user.id}`;
    const messages = adminCopilotService.getSessionMessages(sessionId);

    res.json({
        success: true,
        sessionId,
        messages
    });
}));

/**
 * POST /api/admin/copilot/clear
 * Reinicia la sesión conversacional del administrador
 */
router.post('/clear', catchAsync(async (req, res) => {
    const sessionId = req.body?.sessionId || `admin_web_${req.user.id}`;
    adminCopilotService.clearSession(sessionId);

    res.json({
        success: true,
        message: 'Sesión del Copilot reiniciada correctamente',
        sessionId
    });
}));

export default router;
