-- ==============================================================================
-- MIGRACIÓN: MÓDULO DE PROSPECCIÓN EN INSTAGRAM (MAS.3)
-- ==============================================================================

-- 1. Tabla de Empresas Fuente / Competencia
CREATE TABLE IF NOT EXISTS public.ig_target_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    profile_url TEXT NOT NULL,
    search_keyword TEXT DEFAULT 'manual',
    last_scraped_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Tabla de Leads / Prospectos Extraídos
CREATE TABLE IF NOT EXISTS public.ig_extracted_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.ig_target_companies(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT,
    profile_url TEXT NOT NULL,
    source_post_url TEXT NOT NULL,
    comment_text TEXT,
    ai_intent_score TEXT,
    suggested_dm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'contactado', 'descartado')),
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Índices de Rendimiento
CREATE INDEX IF NOT EXISTS idx_ig_target_companies_scrape_queue 
    ON public.ig_target_companies(is_active, last_scraped_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_ig_extracted_leads_username 
    ON public.ig_extracted_leads(username);

CREATE INDEX IF NOT EXISTS idx_ig_extracted_leads_status 
    ON public.ig_extracted_leads(status);

CREATE INDEX IF NOT EXISTS idx_ig_extracted_leads_company 
    ON public.ig_extracted_leads(company_id);

CREATE INDEX IF NOT EXISTS idx_ig_extracted_leads_extracted_at 
    ON public.ig_extracted_leads(extracted_at DESC);

-- 4. Habilitar Row Level Security (RLS)
ALTER TABLE public.ig_target_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_extracted_leads ENABLE ROW LEVEL SECURITY;

-- 5. Políticas RLS
DROP POLICY IF EXISTS "Permitir gestión a autenticados en ig_target_companies" ON public.ig_target_companies;
CREATE POLICY "Permitir gestión a autenticados en ig_target_companies"
    ON public.ig_target_companies FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir gestión a autenticados en ig_extracted_leads" ON public.ig_extracted_leads;
CREATE POLICY "Permitir gestión a autenticados en ig_extracted_leads"
    ON public.ig_extracted_leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir lectura anon ig_target_companies" ON public.ig_target_companies;
CREATE POLICY "Permitir lectura anon ig_target_companies"
    ON public.ig_target_companies FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Permitir lectura anon ig_extracted_leads" ON public.ig_extracted_leads;
CREATE POLICY "Permitir lectura anon ig_extracted_leads"
    ON public.ig_extracted_leads FOR SELECT TO anon USING (true);

COMMENT ON TABLE public.ig_target_companies IS 'Empresas de remodelación y diseño seguidas como fuente de prospección';
COMMENT ON TABLE public.ig_extracted_leads IS 'Prospectos calificados extraídos de publicaciones de competidores con DM generado por IA';
