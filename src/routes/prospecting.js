import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { runInstagramScraper } from '../../scripts/ig_scraper.js';
import { logger } from '../middleware/logger.js';

const router = express.Router();

let isScraperRunning = false;

/**
 * GET /api/prospecting/kpis
 * Obtiene métricas clave para el panel de prospección
 */
router.get('/kpis', async (req, res) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const [companiesRes, todayLeadsRes, pendingLeadsRes, totalLeadsRes] = await Promise.all([
            supabaseAdmin.from('ig_target_companies').select('id', { count: 'exact', head: true }).eq('is_active', true),
            supabaseAdmin.from('ig_extracted_leads').select('id', { count: 'exact', head: true }).gte('extracted_at', todayStart.toISOString()),
            supabaseAdmin.from('ig_extracted_leads').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'),
            supabaseAdmin.from('ig_extracted_leads').select('id', { count: 'exact', head: true })
        ]);

        res.json({
            success: true,
            data: {
                activeCompanies: companiesRes.count || 0,
                leadsExtractedToday: todayLeadsRes.count || 0,
                pendingLeads: pendingLeadsRes.count || 0,
                totalLeads: totalLeadsRes.count || 0,
                isScraperRunning
            }
        });
    } catch (err) {
        logger.error('Error al obtener KPIs de prospección:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al consultar KPIs' });
    }
});

/**
 * GET /api/prospecting/companies
 * Listar empresas objetivo
 */
router.get('/companies', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('ig_target_companies')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        logger.error('Error al listar empresas objetivo:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al listar empresas' });
    }
});

/**
 * POST /api/prospecting/companies
 * Agregar manualmente una empresa competidora o keyword semilla
 */
router.post('/companies', async (req, res) => {
    try {
        let { username, search_keyword = 'manual' } = req.body;
        if (!username) {
            return res.status(400).json({ success: false, error: 'El nombre de usuario es obligatorio' });
        }

        // Limpiar @ y espacios
        username = username.replace(/^@/, '').trim().toLowerCase();
        const profileUrl = `https://www.instagram.com/${username}/`;

        const { data, error } = await supabaseAdmin
            .from('ig_target_companies')
            .insert({
                username,
                profile_url: profileUrl,
                search_keyword,
                is_active: true
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, error: 'Esta empresa ya está registrada' });
            }
            throw error;
        }

        res.status(201).json({ success: true, data });
    } catch (err) {
        logger.error('Error al registrar empresa objetivo:', { error: err.message });
        res.status(500).json({ success: false, error: err.message || 'Error al registrar empresa' });
    }
});

/**
 * PATCH /api/prospecting/companies/:id
 * Actualizar estado (is_active) de una empresa
 */
router.patch('/companies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;

        const { data, error } = await supabaseAdmin
            .from('ig_target_companies')
            .update({ is_active })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        logger.error('Error al actualizar empresa objetivo:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al actualizar empresa' });
    }
});

/**
 * DELETE /api/prospecting/companies/:id
 * Eliminar una empresa
 */
router.delete('/companies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabaseAdmin
            .from('ig_target_companies')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: 'Empresa eliminada correctamente' });
    } catch (err) {
        logger.error('Error al eliminar empresa objetivo:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al eliminar empresa' });
    }
});

/**
 * GET /api/prospecting/leads
 * Listar prospectos extraídos con filtros opcionales
 */
router.get('/leads', async (req, res) => {
    try {
        const { status } = req.query;
        let query = supabaseAdmin
            .from('ig_extracted_leads')
            .select(`
                *,
                company:company_id (
                    id,
                    username,
                    profile_url
                )
            `)
            .order('extracted_at', { ascending: false });

        if (status && status !== 'todos') {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ success: true, data });
    } catch (err) {
        logger.error('Error al listar prospectos extraídos:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al listar prospectos' });
    }
});

/**
 * PATCH /api/prospecting/leads/:id
 * Actualizar estado (pendiente/contactado/descartado) o suggested_dm
 */
router.patch('/leads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, suggested_dm } = req.body;

        const updates = {};
        if (status !== undefined) updates.status = status;
        if (suggested_dm !== undefined) updates.suggested_dm = suggested_dm;

        const { data, error } = await supabaseAdmin
            .from('ig_extracted_leads')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        logger.error('Error al actualizar prospecto:', { error: err.message });
        res.status(500).json({ success: false, error: 'Error al actualizar prospecto' });
    }
});

/**
 * POST /api/prospecting/run
 * Disparar ejecución del asistente de prospección en segundo plano
 */
router.post('/run', async (req, res) => {
    if (isScraperRunning) {
        return res.status(409).json({
            success: false,
            message: 'El asistente de prospección ya se encuentra en ejecución activa.'
        });
    }

    isScraperRunning = true;
    res.json({
        success: true,
        message: 'Ejecución del asistente de prospección iniciada en segundo plano.'
    });

    // Ejecución asíncrona
    (async () => {
        try {
            logger.info('Iniciando corrida de prospección disparada desde el panel web...');
            await runInstagramScraper();
        } catch (e) {
            logger.error('Error en ejecución en background del scraper:', { error: e.message });
        } finally {
            isScraperRunning = false;
        }
    })();
});

export default router;
