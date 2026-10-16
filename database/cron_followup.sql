-- ==============================================================================
-- CRON JOB: SEGUIMIENTO AUTOMÁTICO DE CHATS INACTIVOS (SUPABASE EDGE FUNCTION)
-- ==============================================================================

-- 1. Habilitar las extensiones necesarias en PostgreSQL
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Eliminar el cron job si ya existía para evitar ejecuciones duplicadas
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-chat-followups') THEN
    PERFORM cron.unschedule('check-chat-followups');
  END IF;
END $$;

-- 3. Programar la ejecución cada minuto (* * * * *)
-- INSTRUCCIONES:
--   - Reemplaza <TU_PROJECT_REF> por el Reference ID de tu proyecto de Supabase (ej: xyzabcdefgh).
--   - Reemplaza <TU_SUPABASE_SERVICE_ROLE_KEY> por tu Service Role Key de Supabase (Settings -> API).
SELECT cron.schedule(
  'check-chat-followups',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://<TU_PROJECT_REF>.supabase.co/functions/v1/followup-template',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <TU_SUPABASE_SERVICE_ROLE_KEY>'
    ),
    body := jsonb_build_object('triggered_at', now())
  ) AS request_id;
  $$
);

-- ==============================================================================
-- CONSULTAS ÚTILES DE MONITOREO Y GESTIÓN
-- ==============================================================================

-- Listar cron jobs programados:
-- SELECT * FROM cron.job;

-- Ver los últimos registros de ejecución del cron job:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Ver el estado de las peticiones HTTP realizadas por pg_net:
-- SELECT * FROM net._http_response ORDER BY created DESC LIMIT 20;

-- Si en el futuro deseas pausar o eliminar el cron job:
-- SELECT cron.unschedule('check-chat-followups');
