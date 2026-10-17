import winston from 'winston';

/**
 * Sistema de logging con Winston
 * Logs se guardan en archivos y consola según el entorno
 */
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'whatsapp-ai-assistant' },
    transports: [
        // Logs de error en archivo separado
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        // Todos los logs en archivo combinado
        new winston.transports.File({
            filename: 'combined.log',
            maxsize: 5242880,
            maxFiles: 5,
        }),
    ]
});

// Mostrar SIEMPRE en consola para que los logs sean visibles en Railway, Docker y terminal
logger.add(new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const cleanMeta = { ...meta };
            delete cleanMeta.service;
            const metaStr = Object.keys(cleanMeta).length ? ` ${JSON.stringify(cleanMeta)}` : '';
            return `[${timestamp}] ${level}: ${message}${metaStr}`;
        })
    )
}));

/**
 * Middleware de Express para logging de requests
 */
export function requestLogger(req, res, next) {
    const start = Date.now();

    // Log cuando termine la respuesta
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('HTTP Request', {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });

    next();
}
