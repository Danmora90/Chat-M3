import { Router } from "express";
import { supabaseAdmin } from "../services/supabase.js";
import { logger } from "../middleware/logger.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

// Proteger todas las rutas del CRM comercial: requiere usuario autenticado y activo
router.use(authMiddleware);

// 1. Obtener datos estructurados para el Tablero Kanban
router.get("/kanban", async (req, res) => {
    try {
        // Definir etapas válidas oficiales
        const VALID_STAGES = new Set([
            '1 - No tiene presupuesto',
            '2 - Credito negado',
            '3 - Le entregan lejos',
            '4 - Escribió',
            '5 - Pidio info',
            '6 - Lead',
            '7 - No asistio',
            '8 - Agendado',
            '9 - Cotizado',
            '10 - Cliente',
            '11 - Perdido',
            '12 - No agendo'
        ]);

        const LEGACY_STAGE_MAP = {
            '5 - Cotizado': '6 - Lead',
            '1 - Contactado': '4 - Escribió',
            '2 - Interesado': '6 - Lead',
            '3 - Cita Agendada': '8 - Agendado',
            '4 - Cotizado': '9 - Cotizado',
            '6 - En Negociación': '9 - Cotizado',
            '7 - Ganado': '10 - Cliente'
        };

        // Auto-sincronizar chats que no tengan aún su correspondiente registro en projects
        const { data: allChats } = await supabaseAdmin.from("chats").select("id, funnel_stage");
        if (allChats && allChats.length > 0) {
            const { data: existingProjects } = await supabaseAdmin.from("projects").select("chat_id");
            const existingChatIds = new Set((existingProjects || []).map(p => p.chat_id));
            const missingChats = allChats.filter(c => !existingChatIds.has(c.id));

            if (missingChats.length > 0) {
                const newProjectsPayload = missingChats.map(c => {
                    const validStage = VALID_STAGES.has(c.funnel_stage)
                        ? c.funnel_stage
                        : (LEGACY_STAGE_MAP[c.funnel_stage] || '4 - Escribió');
                    return {
                        chat_id: c.id,
                        estatus_embudo: validStage,
                        updated_at: new Date().toISOString()
                    };
                });
                await supabaseAdmin.from("projects").insert(newProjectsPayload);
            }
        }

        // Corregir de inmediato registros en 'projects' que tengan estados no válidos
        const { data: allProjectsCheck } = await supabaseAdmin.from("projects").select("id, chat_id, estatus_embudo");
        if (allProjectsCheck) {
            for (const p of allProjectsCheck) {
                if (p.estatus_embudo && !VALID_STAGES.has(p.estatus_embudo)) {
                    const fixedStage = LEGACY_STAGE_MAP[p.estatus_embudo] || '6 - Lead';
                    await supabaseAdmin.from("projects").update({ estatus_embudo: fixedStage, updated_at: new Date().toISOString() }).eq("id", p.id);
                    if (p.chat_id) {
                        await supabaseAdmin.from("chats").update({ funnel_stage: fixedStage, updated_at: new Date().toISOString() }).eq("id", p.chat_id);
                    }
                }
            }
        }
        const { data: projects, error } = await supabaseAdmin
            .from("projects")
            .select(`
                id,
                total_area_m2,
                budget_total,
                is_viable,
                area_viable_m2,
                valor_cotizado_min,
                valor_cotizado_max,
                estatus_embudo,
                estatus_proyecto,
                fecha_entrega_constructora,
                next_action,
                fecha_next_action,
                fecha_descuento,
                valor_descuento,
                observaciones,
                created_at,
                updated_at,
                chat:chats (
                    id,
                    status,
                    funnel_stage,
                    is_ai_paused,
                    last_message_preview,
                    last_message_at,
                    user:users (
                        id,
                        phone_number,
                        display_name
                    )
                )
            `)
            .order("updated_at", { ascending: false });

        if (error) throw error;

        // Definir columnas Kanban estándar
        const stages = [
            '1 - No tiene presupuesto',
            '2 - Credito negado',
            '3 - Le entregan lejos',
            '4 - Escribió',
            '5 - Pidio info',
            '6 - Lead',
            '7 - No asistio',
            '8 - Agendado',
            '9 - Cotizado',
            '10 - Cliente',
            '11 - Perdido',
            '12 - No agendo'
        ];

        const kanbanData = stages.reduce((acc, stage) => {
            acc[stage] = (projects || []).filter(p => (p.estatus_embudo || '4 - Escribió') === stage);
            return acc;
        }, {});

        res.json({ success: true, data: kanbanData });
    } catch (error) {
        logger.error("Error fetching Kanban data:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Obtener lista completa de Leads/Proyectos con filtros
router.get("/leads", async (req, res) => {
    try {
        const { stage, search, page = 1, limit = 50 } = req.query;

        // Auto-sincronizar chats que no tengan aún su correspondiente registro en projects
        const { data: allChats } = await supabaseAdmin.from("chats").select("id, funnel_stage");
        if (allChats && allChats.length > 0) {
            const { data: existingProjects } = await supabaseAdmin.from("projects").select("chat_id");
            const existingChatIds = new Set((existingProjects || []).map(p => p.chat_id));
            const missingChats = allChats.filter(c => !existingChatIds.has(c.id));

            if (missingChats.length > 0) {
                const newProjectsPayload = missingChats.map(c => ({
                    chat_id: c.id,
                    estatus_embudo: c.funnel_stage || '4 - Escribió',
                    updated_at: new Date().toISOString()
                }));
                await supabaseAdmin.from("projects").insert(newProjectsPayload);
            }
        }
        let query = supabaseAdmin
            .from("projects")
            .select(`
                *,
                chat:chats (
                    id,
                    status,
                    funnel_stage,
                    is_ai_paused,
                    last_message_preview,
                    last_message_at,
                    user:users (
                        id,
                        phone_number,
                        display_name
                    )
                )
            `, { count: 'exact' });

        if (stage) {
            query = query.eq("estatus_embudo", stage);
        }

        const fromIndex = (Number(page) - 1) * Number(limit);
        const toIndex = fromIndex + Number(limit) - 1;

        const { data, count, error } = await query
            .range(fromIndex, toIndex)
            .order("updated_at", { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data,
            pagination: {
                total: count,
                page: Number(page),
                limit: Number(limit)
            }
        });
    } catch (error) {
        logger.error("Error fetching leads list:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Vista de Barrido (Leads fríos/inactivos para re-contacto)
router.get("/sweep", async (req, res) => {
    try {
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() - 3); // Más de 3 días sin interacción

        const { data, error } = await supabaseAdmin
            .from("projects")
            .select(`
                *,
                chat:chats (
                    id,
                    status,
                    funnel_stage,
                    last_message_at,
                    last_message_preview,
                    user:users (
                        id,
                        phone_number,
                        display_name
                    )
                )
            `)
            .lt("updated_at", thresholdDate.toISOString())
            .not("estatus_embudo", "in", '("10 - Cliente","11 - Perdido")')
            .order("updated_at", { ascending: true });

        if (error) throw error;

        res.json({ success: true, data });
    } catch (error) {
        logger.error("Error fetching sweep leads:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Actualizar estado de Lead/Proyecto manualmente por el usuario
router.patch("/projects/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const {
            estatus_embudo,
            estatus_proyecto,
            next_action,
            fecha_next_action,
            fecha_entrega_constructora,
            fecha_descuento,
            valor_descuento,
            observaciones,
            budget_total,
            total_area_m2
        } = req.body;

        const updatePayload = { updated_at: new Date().toISOString() };
        if (estatus_embudo !== undefined) updatePayload.estatus_embudo = estatus_embudo;
        if (estatus_proyecto !== undefined) updatePayload.estatus_proyecto = estatus_proyecto;
        if (next_action !== undefined) updatePayload.next_action = next_action;
        if (fecha_next_action !== undefined) updatePayload.fecha_next_action = fecha_next_action;
        if (fecha_entrega_constructora !== undefined) updatePayload.fecha_entrega_constructora = fecha_entrega_constructora;
        if (fecha_descuento !== undefined) updatePayload.fecha_descuento = fecha_descuento;
        if (valor_descuento !== undefined) updatePayload.valor_descuento = valor_descuento;
        if (observaciones !== undefined) updatePayload.observaciones = observaciones;
        if (budget_total !== undefined) updatePayload.budget_total = budget_total;
        if (total_area_m2 !== undefined) updatePayload.total_area_m2 = total_area_m2;

        const { data: updatedProject, error } = await supabaseAdmin
            .from("projects")
            .update(updatePayload)
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        // Si se cambió el estatus_embudo, actualizar también el chat asociado
        if (updatedProject?.chat_id && estatus_embudo) {
            await supabaseAdmin
                .from("chats")
                .update({
                    funnel_stage: estatus_embudo,
                    updated_at: new Date().toISOString()
                })
                .eq("id", updatedProject.chat_id);
        }

        res.json({ success: true, data: updatedProject });
    } catch (error) {
        logger.error("Error updating project:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Métricas del CRM
router.get("/metrics", async (req, res) => {
    try {
        const { data: projects, error } = await supabaseAdmin
            .from("projects")
            .select("is_viable, budget_total, total_area_m2, estatus_embudo, valor_cotizado_min, valor_cotizado_max");

        if (error) throw error;

        const totalProjects = projects?.length || 0;
        const viablesCount = projects?.filter(p => p.is_viable).length || 0;
        const totalCotizado = projects?.reduce((acc, p) => acc + (p.valor_cotizado_max || 0), 0) || 0;

        res.json({
            success: true,
            data: {
                totalProjects,
                viablesCount,
                nonViablesCount: totalProjects - viablesCount,
                viabilityRate: totalProjects ? Math.round((viablesCount / totalProjects) * 100) : 0,
                totalCotizado
            }
        });
    } catch (error) {
        logger.error("Error fetching CRM metrics:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
