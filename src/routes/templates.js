import express from 'express';
import twilio from 'twilio';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { twilioContentService } from '../services/twilioContentService.js';
import { sendWhatsAppTemplate } from '../services/twilio.js';
import { supabaseAdmin, getOrCreateUser, getOrCreateChat, saveMessage } from '../services/supabase.js';
import { updateAgentMemory } from '../agent/graph.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const router = express.Router();

// Rutas protegidas para administración
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * GET /api/admin/templates
 * Lista todas las plantillas creadas
 */
router.get('/', catchAsync(async (req, res) => {
    logger.info('Admin: List WhatsApp templates requested', { adminId: req.user.id });
    const templates = await twilioContentService.listTemplates();
    res.json({
        success: true,
        templates
    });
}));

/**
 * POST /api/admin/templates
 * Crea una nueva plantilla en Twilio y la envía a aprobación a Meta/WhatsApp
 */
router.post('/', catchAsync(async (req, res) => {
    const { friendlyName, category, language, body, variables, variableSamples } = req.body;

    if (!friendlyName || !body) {
        return res.status(400).json({ error: 'friendlyName y body son requeridos' });
    }

    // Extraer variables si no fueron enviadas explícitamente, ej: {{1}}, {{2}}
    let detectedVars = variables;
    if (!detectedVars || !Array.isArray(detectedVars)) {
        const matches = body.match(/\{\{([0-9a-zA-Z_]+)\}\}/g) || [];
        detectedVars = [...new Set(matches.map(m => m.replace(/[\{\}]/g, '')))];
    }

    logger.info('Admin: Creating new WhatsApp template', {
        adminId: req.user.id,
        friendlyName,
        category,
        language,
        detectedVars,
        hasCustomSamples: !!variableSamples
    });

    const result = await twilioContentService.createAndSubmitTemplate({
        friendlyName,
        category: category || 'UTILITY',
        language: language || 'es',
        body,
        variables: detectedVars,
        variableSamples: variableSamples || {}
    });

    res.status(201).json({
        success: true,
        template: result
    });
}));

/**
 * GET /api/admin/templates/:sid/status
 * Consulta y actualiza el estado de aprobación en WhatsApp desde Twilio
 */
router.get('/:sid/status', catchAsync(async (req, res) => {
    const { sid } = req.params;
    logger.info('Admin: Fetching template status', { adminId: req.user.id, contentSid: sid });

    const statusInfo = await twilioContentService.getTemplateStatus(sid);
    res.json({
        success: true,
        statusInfo
    });
}));

/**
 * DELETE /api/admin/templates/:sid
 * Elimina una plantilla de Twilio y de la base de datos
 */
router.delete('/:sid', catchAsync(async (req, res) => {
    const { sid } = req.params;
    logger.info('Admin: Deleting template', { adminId: req.user.id, contentSid: sid });

    const result = await twilioContentService.deleteTemplate(sid);
    res.json({
        success: true,
        result
    });
}));

/**
 * POST /api/admin/templates/:sid/send
 * Envía una plantilla a un destinatario y la registra en el historial de chat
 */
router.post('/:sid/send', catchAsync(async (req, res) => {
    const { sid } = req.params;
    const { to, variables } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'El número destinatario (to) es requerido' });
    }

    logger.info('Admin: Sending WhatsApp template', {
        adminId: req.user?.id,
        contentSid: sid,
        to
    });

    // 1. Enviar el mensaje con Twilio
    const response = await sendWhatsAppTemplate(to, sid, variables || {});

    // 2. Obtener el cuerpo renderizado de la plantilla para el chat
    const messageBody = await twilioContentService.getRenderedTemplateBody(sid, variables || {});

    // 3. Registrar el mensaje en la conversación activa del usuario en Supabase
    let savedMsg = null;
    try {
        const cleanTo = String(to).replace(/^whatsapp:/i, '').trim().replace(/[^\d+]/g, '');
        const phoneNumber = cleanTo.startsWith('+') ? cleanTo : `+${cleanTo}`;
        const storeId = process.env.STORE_ID || null;

        const user = await getOrCreateUser(phoneNumber, storeId);
        const chat = await getOrCreateChat(user.id, storeId);

        savedMsg = await saveMessage(
            chat.id,
            user.id,
            'assistant',
            messageBody,
            {
                template: true,
                content_sid: sid,
                variables: variables || {},
                sent_by_admin: req.user?.id || null
            },
            response.sid
        );

        logger.info('Admin: Template message saved to chat history', {
            chatId: chat.id,
            userId: user.id,
            messageId: savedMsg?.id
        });

        // Sincronizar mensaje de plantilla en la memoria de LangGraph
        await updateAgentMemory(
            chat.id,
            {
                role: 'assistant',
                content: messageBody
            },
            {
                userPhone: phoneNumber,
                userId: user.id
            }
        );
    } catch (saveErr) {
        logger.error('Error saving template message to chat history', saveErr);
    }

    res.json({
        success: true,
        messageSid: response.sid,
        message: savedMsg
    });
}));

export default router;
