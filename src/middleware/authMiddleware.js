import { supabase, supabaseAdmin } from '../services/supabase.js';

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Falta el token o el formato es incorrecto' });
    }

    const token = authHeader.split(' ')[1];

    // Validación nativa de Supabase Auth
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('Error de Supabase Auth:', error?.message);
      return res.status(401).json({ error: 'Token rechazado por Supabase' });
    }

    // Obtener rol del perfil de operador en public.profiles
    let userRole = 'USER';
    let fullName = user.user_metadata?.full_name || '';

    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role, full_name')
        .eq('id', user.id)
        .maybeSingle();

      if (profile?.role) {
        userRole = profile.role.toUpperCase();
      } else if (user.user_metadata?.role) {
        userRole = user.user_metadata.role.toUpperCase();
      }
      if (profile?.full_name) {
        fullName = profile.full_name;
      }
    } catch (profileErr) {
      console.warn('[authMiddleware] Warning fetching profile:', profileErr.message);
    }

    // Garantizar que el correo administrador principal siempre tenga rol ADMIN
    if (user.email === 'danielmoyemanizales@gmail.com') {
      userRole = 'ADMIN';
    }

    req.user = {
      ...user,
      role: userRole,
      full_name: fullName
    };

    next();
  } catch (err) {
    console.error('Error en authMiddleware:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/**
 * Middleware para verificar roles específicos (case-insensitive)
 * Debe usarse DESPUÉS de authMiddleware
 */
export function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Autenticación requerida'
            });
        }

        const userRole = (req.user.role || 'USER').toUpperCase();
        const upperAllowed = allowedRoles.map(r => String(r).toUpperCase());

        if (!upperAllowed.includes(userRole)) {
            console.warn('Insufficient permissions', {
                userId: req.user.id,
                email: req.user.email,
                userRole,
                requiredRoles: upperAllowed,
                path: req.path
            });
            return res.status(403).json({
                error: 'Forbidden',
                message: 'No tienes permisos de Administrador para realizar esta acción'
            });
        }

        next();
    };
}
