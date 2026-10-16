-- ==============================================================================
-- MIGRACIÓN: CONTADOR DE INTERESADOS Y FECHA DE ENTREGA DE CLIENTES
-- ==============================================================================

-- 1. Agregar columnas a scouted_projects si no existen
ALTER TABLE public.scouted_projects
ADD COLUMN IF NOT EXISTS leads_count integer DEFAULT 1,
ADD COLUMN IF NOT EXISTS client_delivery_date text,
ADD COLUMN IF NOT EXISTS client_delivery_dates text[] DEFAULT '{}';

-- 2. Asegurar que los registros existentes tengan leads_count al menos en 1
UPDATE public.scouted_projects
SET leads_count = 1
WHERE leads_count IS NULL OR leads_count < 1;

-- 3. Verificar estructura de la tabla
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'scouted_projects'
  AND column_name IN ('leads_count', 'client_delivery_date', 'client_delivery_dates');
