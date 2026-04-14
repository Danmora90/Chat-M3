import { logger } from '../middleware/logger.js';

/**
 * Clase base para errores personalizados de la aplicación
 */
export class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Error de validación
 */
export class ValidationError extends AppError {
    constructor(message) {
        super(message, 400);
    }
}

/**
 * Error de autenticación
 */
export class AuthenticationError extends AppError {
    constructor(message = 'No autorizado') {
        super(message, 401);
    }
}

/**
 * Error de tasa límite
 */
export class RateLimitError extends AppError {
    constructor(message = 'Demasiadas solicitudes') {
        super(message, 429);
    }
}

/**
 * Manejador global de errores para Express
 */
export function errorHandler(err, req, res, next) {
    let error = err;

    // Si no es un AppError, convertirlo
    if (!(error instanceof AppError)) {
        error = new AppError(
            error.message || 'Error interno del servidor',
            error.statusCode || 500,
            false
        );
    }

    // Log del error
    if (error.statusCode >= 500) {
        logger.error('Server Error', {
            error: error.message,
            stack: error.stack,
            url: req.url,
            method: req.method
        });
    } else {
        logger.warn('Client Error', {
            error: error.message,
            url: req.url,
            method: req.method
        });
    }

    // Enviar respuesta
    res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    });
}

/**
 * Wrapper para funciones async que maneja errores
 */
export const catchAsync = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
