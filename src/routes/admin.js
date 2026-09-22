import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { getPromptDetails, saveSystemPrompt, resetSystemPrompt, getPromptHistory } from '../services/promptService.js';
import { scanResidentialProjects, getScoutedProjectsHistory, deleteScoutedProject, findProjectByName } from '../services/prospectingService.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

// Todas las rutas de administración requieren autenticación y rol ADMIN
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * GET /api/admin/users
 * Lista todos los operadores y miembros del equipo desde public.profiles
 */
router.get('/users', catchAsync(async (req, res) => {
    logger.info('Admin: List users requested', { adminId: req.user.id, adminEmail: req.user.email });

    // Asegurar que el administrador principal exista en la tabla profiles
    if (req.user.email === 'danielmoyemanizales@gmail.com') {
        await supabaseAdmin.from('profiles').upsert({
            id: req.user.id,
            email: req.user.email,
            full_name: req.user.full_name || 'Daniel Mora',
            role: 'ADMIN',
            updated_at: new Date().toISOString()
        });
    }

    const { data: profiles, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, role, avatar_url, created_at, updated_at')
        .order('created_at', { ascending: false });

    if (error) {
        logger.error('Admin: Error fetching profiles', error);
        throw error;
    }

    // Normalizar formato para el frontend
    const users = (profiles || []).map(p => ({
        id: p.id,
        email: p.email,
        full_name: p.full_name || 'Sin Nombre',
        role: (p.role || 'USER').toUpperCase(),
        store_id: 'MAS.3 Sede Principal',
        avatar_url: p.avatar_url,
        created_at: p.created_at
    }));

    res.json(users);
}));

/**
 * POST /api/admin/users
 * Registra un nuevo usuario en Supabase Auth y lo sincroniza en public.profiles
 */
router.post('/users', catchAsync(async (req, res) => {
    const { email, password, full_name, role } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'El correo electrónico y la contraseña son obligatorios' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const assignedRole = (role || 'AGENT').toUpperCase();

    logger.info('Admin: Creating new system user', {
        adminId: req.user.id,
        newEmail: email,
        assignedRole
    });

    // 1. Crear usuario en Supabase Auth usando el API Admin
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: email.trim().toLowerCase(),
        password: password,
        email_confirm: true,
        user_metadata: {
            full_name: full_name?.trim() || '',
            role: assignedRole
        }
    });

    if (authError) {
        logger.error('Admin: Error creating auth user', authError);
        return res.status(400).json({ error: authError.message });
    }

    const newUserId = authData.user.id;

    // 2. Insertar/Sincronizar en public.profiles
    const profilePayload = {
        id: newUserId,
        email: email.trim().toLowerCase(),
        full_name: full_name?.trim() || 'Sin Nombre',
        role: assignedRole,
        updated_at: new Date().toISOString()
    };

    const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .upsert(profilePayload);

    if (profileError) {
        logger.warn('Admin: Warning creating profile row, auth created', profileError);
    }

    res.status(201).json({
        id: newUserId,
        email: profilePayload.email,
        full_name: profilePayload.full_name,
        role: assignedRole,
        store_id: 'MAS.3 Sede Principal'
    });
}));

/**
 * PUT /api/admin/users/:id
 * Actualiza los datos o rol de un usuario existente
 */
router.put('/users/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    const { full_name, role, password } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (full_name !== undefined) updates.full_name = full_name.trim();
    if (role !== undefined) updates.role = role.toUpperCase();

    // Si se envía nueva contraseña, actualizarla en Supabase Auth
    if (password && password.length >= 6) {
        await supabaseAdmin.auth.admin.updateUserById(id, {
            password,
            user_metadata: {
                full_name: updates.full_name,
                role: updates.role
            }
        });
    }

    const { data: updatedProfile, error } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        logger.error('Admin: Error updating profile', error);
        throw error;
    }

    res.json({
        id: updatedProfile.id,
        email: updatedProfile.email,
        full_name: updatedProfile.full_name,
        role: (updatedProfile.role || 'USER').toUpperCase(),
        store_id: 'MAS.3 Sede Principal'
    });
}));

/**
 * DELETE /api/admin/users/:id
 * Revoca y elimina un usuario de la plataforma
 */
router.delete('/users/:id', catchAsync(async (req, res) => {
    const { id } = req.params;

    if (req.user.id === id) {
        return res.status(400).json({ error: 'Por seguridad, no puedes eliminar tu propio usuario administrador' });
    }

    logger.info('Admin: Deleting user', { adminId: req.user.id, targetUserId: id });

    // 1. Eliminar de Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authError) {
        logger.error('Admin: Error deleting auth user', authError);
    }

    // 2. Eliminar de public.profiles
    await supabaseAdmin.from('profiles').delete().eq('id', id);

    res.json({ success: true, message: 'Usuario eliminado exitosamente' });
}));

/**
 * GET /api/admin/prompt
 * Obtiene el prompt activo del sistema, si es personalizado y la versión por defecto
 */
router.get('/prompt', catchAsync(async (req, res) => {
    logger.info('Admin: Prompt details requested', { adminId: req.user.id });
    const details = await getPromptDetails();
    res.json(details);
}));

/**
 * PUT /api/admin/prompt
 * Actualiza el prompt del sistema en Supabase y en la memoria del agente
 */
router.put('/prompt', catchAsync(async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        return res.status(400).json({ error: 'El contenido del prompt no puede estar vacío' });
    }

    logger.info('Admin: Updating system prompt', { adminId: req.user.id, email: req.user.email });
    const result = await saveSystemPrompt(prompt, req.user.email);
    res.json(result);
}));

/**
 * POST /api/admin/prompt/reset
 * Restablece el prompt a la versión de fábrica (system.js)
 */
router.post('/prompt/reset', catchAsync(async (req, res) => {
    logger.info('Admin: Resetting prompt to factory default', { adminId: req.user.id });
    const result = await resetSystemPrompt(req.user.email);
    res.json(result);
}));

/**
 * GET /api/admin/prompt/history
 * Obtiene las últimas 5 versiones del prompt registradas en el historial
 */
router.get('/prompt/history', catchAsync(async (req, res) => {
    logger.info('Admin: Prompt history requested', { adminId: req.user.id });
    const limit = parseInt(req.query.limit, 10) || 5;
    const history = await getPromptHistory(limit);
    res.json(history);
}));

/**
 * POST /api/admin/prospecting/scan
 * Ejecuta el escaneo de proyectos residenciales en Bogotá y Cundinamarca por año y semestre
 */
router.post('/prospecting/scan', catchAsync(async (req, res) => {
    const { city = 'Bogotá', year = '2026', semester = 'all', strata = [4, 5, 6], month } = req.body;
    logger.info('Admin: Residential prospecting scan requested', {
        adminId: req.user.id,
        city,
        year,
        semester,
        strata,
        month
    });

    const projects = await scanResidentialProjects({ city, year, semester, strata, month });
    res.json({
        success: true,
        count: projects.length,
        projects
    });
}));

/**
 * GET /api/admin/prospecting/history
 * Obtiene la lista de proyectos inmobiliarios descubiertos
 */
router.get('/prospecting/history', catchAsync(async (req, res) => {
    const { city, year, semester, month, search } = req.query;
    logger.info('Admin: Prospecting history requested', { adminId: req.user.id, city, year, semester, month, search });
    const projects = await getScoutedProjectsHistory({ city, year, semester, month, search });
    res.json({
        success: true,
        count: projects.length,
        projects
    });
}));

/**
 * POST /api/admin/prospecting/search-project
 * Busca o rastrea un proyecto específico por nombre en constructoras oficiales
 */
router.post('/prospecting/search-project', catchAsync(async (req, res) => {
    const { projectName, city = 'Bogotá' } = req.body;
    logger.info('Admin: Search specific project requested', { adminId: req.user.id, projectName, city });
    const projects = await findProjectByName({ projectName, city });
    res.json({
        success: true,
        count: projects.length,
        projects
    });
}));

/**
 * DELETE /api/admin/prospecting/:id
 * Descarta o elimina un proyecto de la lista de prospección
 */
router.delete('/prospecting/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    logger.info('Admin: Deleting scouted project', { adminId: req.user.id, projectId: id });
    const result = await deleteScoutedProject(id);
    res.json(result);
}));

export default router;
