import { validateTwilioSignature } from '../services/twilio.js';
import { logger } from './logger.js';

/**
 * Middleware para validar webhooks de Twilio
 * Verifica que los requests provengan de Twilio usando la firma
 */
export function twilioWebhookValidator(req, res, next) {
    // En desarrollo o pruebas, permitir requests sin validación si está configurado
    if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
        logger.warn('⚠️ [Twilio Webhook] SKIP_TWILIO_VALIDATION activo: Omitiendo validación de firma');
        return next();
    }

    const signature = req.headers['x-twilio-signature'];

    if (!signature) {
        logger.error('❌ [Twilio Webhook] Falta header X-Twilio-Signature en el request', {
            url: req.originalUrl,
            ip: req.ip
        });
        return res.status(403).json({ error: 'Missing signature' });
    }

    // Construir URL completa del webhook considerando proxy inverso (Railway)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}${req.originalUrl}`;

    const isValid = validateTwilioSignature(signature, url, req.body);

    if (!isValid) {
        logger.error('❌ [Twilio Webhook] Firma de Twilio inválida', {
            urlEvaluada: url,
            signatureReceived: signature,
            hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN
        });
        return res.status(403).json({ error: 'Invalid request signature' });
    }

    logger.info('✅ [Twilio Webhook] Firma de Twilio verificada correctamente');
    next();
}
