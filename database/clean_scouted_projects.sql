-- ==============================================================================
-- LIMPIEZA DE PROYECTOS DE PROSPECCIÓN INMOBILIARIA
-- ==============================================================================
-- Este script vacía los proyectos antiguos para iniciar desde cero.
-- A partir de ahora, la tabla se llenará automáticamente con los proyectos
-- que mencionen los clientes en sus conversaciones con el Asesor IA.

DELETE FROM public.scouted_projects;

-- Verificar que la tabla quedó en cero:
SELECT count(*) AS total_proyectos FROM public.scouted_projects;
