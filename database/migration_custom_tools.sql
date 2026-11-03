-- ==============================================================================
-- MIGRATION: GESTIÓN DE HERRAMIENTAS DINÁMICAS DE IA (CUSTOM TOOLS)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.custom_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE, -- Identificador técnico en minúsculas y sin espacios (ej: 'pausar_chat', 'enviar_email')
    display_name VARCHAR(255) NOT NULL, -- Nombre legible en la interfaz
    description TEXT NOT NULL, -- Descripción semántica para el modelo de OpenAI (cuándo y cómo llamarla)
    tool_type VARCHAR(50) NOT NULL DEFAULT 'database_action', -- 'database_action' | 'http_request'
    parameters JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array de definiciones de parámetros: [{ name, type, description, required, enum_values }]
    execution_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- Configuración de ejecución (tabla, acción, url, headers, etc.)
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_custom_tools_active ON public.custom_tools(is_active);
CREATE INDEX IF NOT EXISTS idx_custom_tools_name ON public.custom_tools(name);

COMMENT ON TABLE public.custom_tools IS 'Herramientas (tools) dinámicas creadas por administradores para ser ejecutadas por el agente de IA';
