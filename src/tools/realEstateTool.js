import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { findProjectByName } from "../services/prospectingService.js";
import { supabaseAdmin } from "../services/supabase.js";
import { logger } from "../middleware/logger.js";

/**
 * Herramienta para que el Asesor IA busque información oficial de un proyecto inmobiliario
 * Rastreando primero en la base de datos local y, si no existe, en páginas oficiales de constructoras.
 */
export const buscarProyectoInmobiliarioTool = tool(
    async ({ nombre_proyecto, ciudad }, config) => {
        try {
            const cleanProjectName = (nombre_proyecto || '').trim();
            if (!cleanProjectName) {
                return "Por favor indica el nombre del proyecto inmobiliario a consultar.";
            }

            const effectiveCity = (ciudad || 'Bogotá').trim();
            logger.info('Agente ejecutando búsqueda de proyecto inmobiliario', {
                proyecto: cleanProjectName,
                ciudad: effectiveCity
            });

            // 1. Ejecutar búsqueda oficial (Supabase primero, luego Serper si no existe)
            const projects = await findProjectByName({
                projectName: cleanProjectName,
                city: effectiveCity
            });

            if (!projects || projects.length === 0) {
                return `No se encontraron datos oficiales en constructoras para el proyecto "${cleanProjectName}". Pregúntale amablemente al cliente cuántos metros cuadrados tiene su apartamento y si tiene una foto o plano para cotizarle.`;
            }

            const proj = projects[0];

            // 2. Asociar opcionalmente el nombre del proyecto al chat/proyecto en Supabase
            const threadId = config?.configurable?.thread_id;
            if (threadId) {
                const chatId = threadId.replace('conversation_', '');
                try {
                    const { data: existingProject } = await supabaseAdmin
                        .from('projects')
                        .select('id, observaciones')
                        .eq('chat_id', chatId)
                        .maybeSingle();

                    const obsText = `Proyecto inmobiliario: ${proj.name} (${proj.builder} - ${proj.city}). Entrega: ${proj.delivery_date || 'N/A'}`;

                    if (existingProject?.id) {
                        const nuevaObs = existingProject.observaciones
                            ? `${existingProject.observaciones} | ${obsText}`
                            : obsText;

                        await supabaseAdmin
                            .from('projects')
                            .update({
                                observaciones: nuevaObs,
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', existingProject.id);
                    }
                } catch (dbErr) {
                    logger.warn('Error asociando proyecto inmobiliario al chat:', dbErr.message);
                }
            }

            // 3. Formatear la respuesta con datos claros y específicos para que el agente asesore al cliente
            let response = `🏢 Proyecto localizado: "${proj.name}"\n`;
            response += `• Constructora: ${proj.builder}\n`;
            response += `• Ubicación: ${proj.city} (${proj.zone || ''}), Estrato ${proj.stratum || 'N/A'}\n`;
            response += `• Fecha estimada de entrega: ${proj.delivery_date || 'Por definir'}\n`;

            if (proj.typologies && proj.typologies.length > 0) {
                response += `• Tipologías y áreas disponibles:\n`;
                proj.typologies.forEach(t => {
                    response += `   - ${t.name}: ${t.area_m2} m² (${t.bedrooms} alcobas, ${t.bathrooms} baños)\n`;
                });
            }

            response += `\nInstrucción para el agente: Usa estos datos para elogiar el proyecto y preguntarle al cliente cuál de esas tipologías o metrajes tiene su apartamento para calcularle el presupuesto de acabados.`;

            return response;
        } catch (error) {
            logger.error('Error en buscarProyectoInmobiliarioTool:', error);
            return `Ocurrió un error consultando el proyecto "${nombre_proyecto}": ${error.message}. Continúa la conversación preguntándole al cliente los metros cuadrados de su apartamento.`;
        }
    },
    {
        name: "buscar_proyecto_inmobiliario",
        description: "Busca y obtiene información técnica y arquitectónica de un proyecto o conjunto residencial nuevo en Colombia (constructora, ubicación, estratos, tipologías en m2 y fechas de entrega). Úsala SIEMPRE que el cliente mencione el nombre del proyecto o conjunto residencial donde compró su apartamento.",
        schema: z.object({
            nombre_proyecto: z.string().describe("Nombre exacto del proyecto de vivienda o conjunto residencial (ejemplo: 'Paseo del Parque', 'Fontana Grande', 'Parque de las Flores', 'Hacienda El Otoño')."),
            ciudad: z.string().optional().describe("Ciudad o municipio del proyecto si el cliente lo mencionó (ejemplo: 'Bogotá', 'Chía', 'Cajicá', 'Mosquera', 'Madrid'). Por defecto 'Bogotá'.")
        })
    }
);
