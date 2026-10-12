-- Migration: WhatsApp Content Templates (Twilio Content API)
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_sid VARCHAR(255) UNIQUE NOT NULL,
    friendly_name VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'UTILITY', -- MARKETING, UTILITY, AUTHENTICATION
    language VARCHAR(10) NOT NULL DEFAULT 'es',
    body TEXT NOT NULL,
    variables JSONB DEFAULT '[]'::jsonb, -- ['1', '2', ...] o keys de variables
    status VARCHAR(50) NOT NULL DEFAULT 'submitted', -- draft, submitted, approved, rejected, paused
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_content_sid ON public.whatsapp_templates(content_sid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_status ON public.whatsapp_templates(status);

-- Comentario descriptivo
COMMENT ON TABLE public.whatsapp_templates IS 'Plantillas de WhatsApp gestionadas a través de Twilio Content API y aprobadas por Meta';
