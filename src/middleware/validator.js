import { validateTwilioSignature } from '../services/twilio.js';
import { logger } from './logger.js';

/**
 * Middleware para validar webhooks de Twilio
 * Verifica que los requests provengan de Twilio usando la firma
 */
export function twilioWebhookValidator(req, res, next) {
    // En desarrollo, permitir requests sin validación si está configurado
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_TWILIO_VALIDATION === 'true') {
        logger.warn('Skipping Twilio webhook validation in development mode');
        return next();
    }

    const signature = req.headers['x-twilio-signature'];

    if (!signature) {
        logger.error('Missing Twilio signature header');
        return res.status(403).json({ error: 'Missing signature' });
    }

    // Construir URL completa del webhook
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}${req.originalUrl}`;

    const isValid = validateTwilioSignature(signature, url, req.body);

    if (!isValid) {
        logger.error('Invalid Twilio signature', { url, signature });
        return res.status(403).json({ error: 'Invalid request signature' });
    }

    next();
}
