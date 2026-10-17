import rateLimit from 'express-rate-limit';

/**
 * Rate limiter configurado para proteger contra abuso
 * Limita por número de teléfono del usuario
 */
export const createRateLimiter = () => {
    return rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto por defecto
        max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5000, // Aumentado drásticamente para evitar bloqueos por polling del frontend
        standardHeaders: true, // Return rate limit info in headers
        legacyHeaders: false,

        // Diferenciar entre webhooks de Twilio (por número) y API (por IP)
        keyGenerator: (req) => {
            const isWebhook = req.originalUrl?.startsWith('/webhook/whatsapp') || req.originalUrl?.startsWith('/m3/whatsapp');
            if (isWebhook && req.body?.From) {
                return req.body.From;
            }
            return req.ip;
        },

        // Mensaje cuando se excede el límite
        handler: (req, res) => {
            res.status(429).json({
                error: 'Demasiados mensajes. Por favor, espera un momento antes de continuar.',
                retryAfter: req.rateLimit.resetTime
            });
        },

        // No aplicar rate limiting a health check
        skip: (req) => req.path === '/health' || req.path === '/api/health'
    });
};
