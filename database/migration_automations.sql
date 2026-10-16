-- ==============================================================================
-- MIGRATION: MOTOR DE AUTOMATIZACIONES Y FLUJOS DE MENSAJERÍA
-- ==============================================================================

-- 1. Tabla de Flujos Configurables
CREATE TABLE IF NOT EXISTS public.automation_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    trigger_type VARCHAR(50) NOT NULL DEFAULT 'stage_change', -- 'stage_change' | 'inactivity'
    trigger_stage VARCHAR(100), -- ej: '8 - Agendado', '6 - Lead', '1 - No tiene presupuesto'
    inactivity_minutes INTEGER DEFAULT 5, -- Minutos de inactividad si trigger_type = 'inactivity'
    is_active BOOLEAN NOT NULL DEFAULT true,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array de pasos con delays, condiciones, plantillas y alertas
    store_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Tabla de Cola de Tareas Programadas
CREATE TABLE IF NOT EXISTS public.automation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id UUID NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'cancelled', 'failed', 'skipped'
    condition_type VARCHAR(50) DEFAULT 'if_no_reply', -- 'always', 'if_no_reply'
    action_type VARCHAR(50) NOT NULL, -- 'send_template', 'notify_admin'
    action_payload JSONB DEFAULT '{}'::jsonb,
    result_details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    executed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Índices de rendimiento para el worker
CREATE INDEX IF NOT EXISTS idx_automation_queue_status_sched ON public.automation_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_automation_queue_chat_id ON public.automation_queue(chat_id);
CREATE INDEX IF NOT EXISTS idx_automation_flows_active ON public.automation_flows(is_active);

COMMENT ON TABLE public.automation_flows IS 'Definición de flujos y secuencias automáticas de WhatsApp configuradas por administradores';
COMMENT ON TABLE public.automation_queue IS 'Cola de ejecución de pasos de automatización programados por tiempo y condición';
