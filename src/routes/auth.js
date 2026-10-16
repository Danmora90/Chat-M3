import express from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { supabaseAdmin } from '../services/supabase.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/**
 * GET /auth/me o /auth/profile
 * Obtiene la información completa del usuario autenticado
 */
router.get(['/me', '/profile'], authMiddleware, catchAsync(async (req, res) => {
    logger.info('Auth: Profile requested', { userId: req.user.id, email: req.user.email });

    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', req.user.id)
        .maybeSingle();

    res.json({
        id: req.user.id,
        email: req.user.email,
        full_name: profile?.full_name || req.user.user_metadata?.full_name || 'Usuario MAS.3',
        job_title: profile?.job_title || req.user.user_metadata?.job_title || (req.user.role === 'ADMIN' ? 'Administrador MAS.3' : 'Asesor Comercial'),
        bio: profile?.bio || req.user.user_metadata?.bio || '',
        avatar_url: profile?.avatar_url || req.user.user_metadata?.avatar_url || null,
        role: (profile?.role || req.user.role || 'USER').toUpperCase(),
        store_id: 'MAS.3 Sede Principal'
    });
}));

/**
 * POST /auth/avatar
 * Sube la foto de perfil a Supabase Storage con permisos de administrador (evita bloqueos RLS)
 */
router.post('/avatar', authMiddleware, upload.single('file'), catchAsync(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se envió ningún archivo de imagen' });
    }

    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const filePath = `avatars/${req.user.id}/${Date.now()}.${ext}`;

    logger.info('Auth: Uploading avatar image', { userId: req.user.id, path: filePath });

    // Subida con supabaseAdmin (Service Role) - Sin restricciones de RLS
    const { error: uploadError } = await supabaseAdmin.storage
        .from('chat-media')
        .upload(filePath, req.file.buffer, {
            contentType: req.file.mimetype || 'image/jpeg',
            upsert: true
        });

    if (uploadError) {
        logger.error('Auth: Error uploading avatar via supabaseAdmin', uploadError);
        throw uploadError;
    }

    const { data: { publicUrl } } = supabaseAdmin.storage
        .from('chat-media')
        .getPublicUrl(filePath);

    // Actualizar inmediatamente en la tabla profiles
    await supabaseAdmin
        .from('profiles')
        .upsert({
            id: req.user.id,
            email: req.user.email,
            avatar_url: publicUrl,
            updated_at: new Date().toISOString()
        });

    // Actualizar en metadata de Auth
    await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
        user_metadata: {
            avatar_url: publicUrl
        }
    });

    res.json({ avatar_url: publicUrl });
}));

/**
 * PUT /auth/profile
 * Actualiza el perfil del usuario autenticado (nombre, puesto, bio, avatar y contraseña)
 */
router.put('/profile', authMiddleware, catchAsync(async (req, res) => {
    const { full_name, job_title, bio, avatar_url, password } = req.body;
    const userId = req.user.id;

    logger.info('Auth: Updating profile', { userId, email: req.user.email });

    // 1. Preparar campos para actualizar en public.profiles
    const updates = {
        updated_at: new Date().toISOString()
    };

    if (full_name !== undefined) updates.full_name = full_name.trim();
    if (job_title !== undefined) updates.job_title = job_title.trim();
    if (bio !== undefined) updates.bio = bio.trim();
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;

    // Actualizar o crear fila en profiles
    const { data: updatedProfile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .upsert({
            id: userId,
            email: req.user.email,
            role: req.user.role || 'AGENT',
            ...updates
        })
        .select()
        .single();

    if (profileError) {
        logger.error('Auth: Error updating profile table', profileError);
        throw profileError;
    }

    // 2. Si se solicitó cambio de contraseña o metadata en Auth
    const authUpdates = {
        user_metadata: {
            full_name: updates.full_name || updatedProfile.full_name,
            job_title: updates.job_title || updatedProfile.job_title,
            bio: updates.bio || updatedProfile.bio,
            avatar_url: updates.avatar_url || updatedProfile.avatar_url
        }
    };

    if (password && password.trim().length > 0) {
        if (password.trim().length < 6) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
        }
        authUpdates.password = password.trim();
    }

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdates);

    if (authError) {
        logger.error('Auth: Error updating Supabase Auth user metadata/password', authError);
    }

    res.json({
        id: userId,
        email: req.user.email,
        full_name: updatedProfile.full_name,
        job_title: updatedProfile.job_title || (req.user.role === 'ADMIN' ? 'Administrador MAS.3' : 'Asesor Comercial'),
        bio: updatedProfile.bio || '',
        avatar_url: updatedProfile.avatar_url || null,
        role: (updatedProfile.role || req.user.role || 'USER').toUpperCase(),
        store_id: 'MAS.3 Sede Principal'
    });
}));

export default router;
