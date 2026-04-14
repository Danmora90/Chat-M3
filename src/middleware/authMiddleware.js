import { supabase } from '../services/supabase.js';

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Falta el token o el formato es incorrecto' });
    }

    const token = authHeader.split(' ')[1];

    // Validación nativa de Supabase (Infalible)
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('Error de Supabase Auth:', error.message);
      return res.status(401).json({ error: 'Token rechazado por Supabase' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Error catastrófico en middleware:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Middleware opcional para verificar roles específicos
 * Debe usarse DESPUÉS de authMiddleware
 * 
 * @param {Array<string>} allowedRoles - Roles permitidos
 * @returns {Function} Middleware de Express
 */
export function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Autenticación requerida'
            });
        }

        const userRole = req.user.role || 'user';

        if (!allowedRoles.includes(userRole)) {
            console.warn('Insufficient permissions', {
                userId: req.user.id,
                userRole,
                requiredRoles: allowedRoles,
                path: req.path
            });
            return res.status(403).json({
                error: 'Forbidden',
                message: 'No tienes permisos para acceder a este recurso'
            });
        }

        next();
    };
}
