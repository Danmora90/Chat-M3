import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { findProjectByName } from "../services/prospectingService.js";
import { supabaseAdmin } from "../services/supabase.js";
import { logger } from "../middleware/logger.js";

/**
 * Determina si una fecha textual estimada de entrega está a más de 4 meses de distancia
 * @param {string} fechaTexto - Ej: "Julio de 2027", "2027-07", "Diciembre 2026", "2028"
 * @returns {boolean} True si la fecha es superior a 4 meses desde hoy
 */
function isDeliveryFar(fechaTexto) {
    if (!fechaTexto) return false;
    const lower = fechaTexto.toLowerCase().trim();

    // Extraer año de 4 dígitos si está presente
    const yearMatch = lower.match(/\b(202[4-9]|203[0-9])\b/);
    const targetYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1 - 12

    if (targetYear && targetYear > currentYear + 1) {
        // Años posteriores a 2027 son automáticamente lejanos
        return true;
    }

    // Mapa de meses en español
    const months = {
        'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
        'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
    };

    let targetMonth = null;
    for (const [mName, mNum] of Object.entries(months)) {
        if (lower.includes(mName)) {
            targetMonth = mNum;
            break;
        }
    }

    if (lower.includes('segundo semestre') || lower.includes('2do semestre') || lower.includes('finales de')) {
        targetMonth = targetMonth || 9; // ~Septiembre
    } else if (lower.includes('primer semestre') || lower.includes('1er semestre') || lower.includes('inicios de')) {
        targetMonth = targetMonth || 3; // ~Marzo
    }

    if (targetYear) {
        const monthDiff = (targetYear - currentYear) * 12 + ((targetMonth || 6) - currentMonth);
        return monthDiff > 4;
    }

    return false;
}

/**
 * Herramienta para que el Asesor IA busque información oficial de un proyecto inmobiliario,
 * gestione el contador de clientes interesados y registre la fecha de entrega del apartamento.
 */
export const buscarProyectoInmobiliarioTool = tool(
    async ({ nombre_proyecto, fecha_entrega_cliente, ciudad }, config) => {
        try {
            const cleanProjectName = (nombre_proyecto || '').trim();
            if (!cleanProjectName) {
                return "Por favor indica el nombre del proyecto inmobiliario a consultar.";
            }

            const cleanDeliveryDate = fecha_entrega_cliente ? fecha_entrega_cliente.trim() : null;
            const effectiveCity = (ciudad || 'Bogotá').trim();

            logger.info('Agente ejecutando búsqueda de proyecto inmobiliario', {
                proyecto: cleanProjectName,
                fechaEntregaCliente: cleanDeliveryDate,
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
            const threadId = config?.configurable?.thread_id;
            const chatId = threadId ? threadId.replace('conversation_', '') : null;

            // 2. Gestionar contador de interesados (leads_count) e idempotencia por chat
            let currentLeadsCount = proj.leads_count || 1;
            let isNewChatForProject = false;

            if (chatId) {
                try {
                    // Consultar metadata actual del chat
                    const { data: chatData } = await supabaseAdmin
                        .from('chats')
                        .select('id, metadata')
                        .eq('id', chatId)
                        .maybeSingle();

                    const chatMeta = chatData?.metadata || {};
                    const updatedChatMeta = {
                        ...chatMeta,
                        scouted_project_id: proj.id,
                        project_name: proj.name
                    };

                    if (cleanDeliveryDate) {
                        updatedChatMeta.client_delivery_date = cleanDeliveryDate;
                    }

                    // Si este chat NO estaba asociado previamente a este proyecto, contamos un nuevo lead
                    if (chatMeta.scouted_project_id !== proj.id) {
                        isNewChatForProject = true;

                        // Si el proyecto ya existía en la BD antes de esta llamada, incrementamos su contador
                        if (proj._isExisting) {
                            currentLeadsCount = (proj.leads_count || 1) + 1;
                        } else {
                            currentLeadsCount = 1;
                        }
                    }

                    // Actualizar metadata del chat
                    await supabaseAdmin
                        .from('chats')
                        .update({
                            metadata: updatedChatMeta,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', chatId);
                } catch (chatErr) {
                    logger.warn('Error verificando chat para contador de proyecto:', chatErr.message);
                }
            }

            // 3. Actualizar scouted_projects con el nuevo contador y fecha de entrega si aplica
            const updatePayload = {};
            if (isNewChatForProject && proj._isExisting) {
                updatePayload.leads_count = currentLeadsCount;
            }

            if (cleanDeliveryDate) {
                updatePayload.client_delivery_date = cleanDeliveryDate;

                // Actualizar array histórico de fechas de entrega reportadas
                const currentDates = Array.isArray(proj.client_delivery_dates) ? proj.client_delivery_dates : [];
                if (!currentDates.includes(cleanDeliveryDate)) {
                    updatePayload.client_delivery_dates = [...currentDates, cleanDeliveryDate];
                }
            }

            if (Object.keys(updatePayload).length > 0) {
                try {
                    await supabaseAdmin
                        .from('scouted_projects')
                        .update(updatePayload)
                        .eq('id', proj.id);
                    logger.info(`Proyecto ${proj.name} actualizado en Supabase:`, updatePayload);
                } catch (updateErr) {
                    logger.warn('Error actualizando scouted_projects:', updateErr.message);
                }
            }

            // 4. Actualizar observaciones y próxima acción en la tabla projects del CRM
            if (chatId) {
                try {
                    const { data: existingProject } = await supabaseAdmin
                        .from('projects')
                        .select('id, observaciones')
                        .eq('chat_id', chatId)
                        .maybeSingle();

                    let obsText = `Proyecto: ${proj.name} (${proj.builder} - ${proj.city}).`;
                    if (cleanDeliveryDate) {
                        obsText += ` Entrega informada por cliente: ${cleanDeliveryDate}.`;
                    }

                    const crmPayload = {
                        observaciones: existingProject?.observaciones
                            ? `${existingProject.observaciones} | ${obsText}`
                            : obsText,
                        updated_at: new Date().toISOString()
                    };

                    if (cleanDeliveryDate) {
                        crmPayload.next_action = `Entrega de inmueble: ${cleanDeliveryDate}`;
                    }

                    if (existingProject?.id) {
                        await supabaseAdmin.from('projects').update(crmPayload).eq('id', existingProject.id);
                    }
                } catch (dbErr) {
                    logger.warn('Error asociando proyecto inmobiliario al CRM:', dbErr.message);
                }
            }

            // 5. Analizar si la fecha de entrega es lejana (> 4 meses)
            const isFar = cleanDeliveryDate ? isDeliveryFar(cleanDeliveryDate) : false;

            // 6. Formatear la respuesta para el Asesor IA
            let response = `🏢 Proyecto localizado: "${proj.name}"\n`;
            response += `• Constructora: ${proj.builder}\n`;
            response += `• Ubicación: ${proj.city} (${proj.zone || ''}), Estrato ${proj.stratum || 'N/A'}\n`;
            response += `• Total clientes interesados registrados en este proyecto: ${currentLeadsCount}\n`;
            response += `• Entrega estimada constructora: ${proj.delivery_date || 'Por definir'}\n`;

            if (cleanDeliveryDate) {
                response += `• Fecha de entrega indicada por el cliente: "${cleanDeliveryDate}"\n`;
            }

            if (proj.typologies && proj.typologies.length > 0) {
                response += `• Tipologías disponibles en el proyecto:\n`;
                proj.typologies.forEach(t => {
                    response += `   - ${t.name}: ${t.area_m2} m² (${t.bedrooms} alcobas, ${t.bathrooms} baños)\n`;
                });
            }

            if (isFar) {
                response += `\n🚨 REGLA OBLIGATORIA DE ENTREGA LEJANA (> 4 MESES):`;
                response += `\nEl cliente te indicó que la entrega es para "${cleanDeliveryDate}", lo cual es posterior a 4 meses.`;
                response += `\n1. Explícale amablemente que por la distancia en el tiempo los precios exactos de materiales y mano de obra pueden fluctuar, por lo que no es prudente darle una cotización cerrada ahorita.`;
                response += `\n2. Dile que dejamos sus datos registrados y que con mucho gusto lo contactaremos cuando falten 2 o 3 meses para la entrega de su apartamento.`;
                response += `\n3. EJECUTA INMEDIATAMENTE la herramienta 'crm_sync_updater' con funnel_stage: "3 - Le entregan lejos".`;
            } else if (!cleanDeliveryDate) {
                response += `\n💡 RECOMENDACIÓN: Pregúntale amablemente al cliente: "¿Para qué fecha te tiene programada la entrega la constructora?" y qué tipología o metraje tiene su apartamento.`;
            } else {
                response += `\n💡 La fecha de entrega está próxima (dentro de los próximos 4 meses). Procede a preguntarle cuál de esas tipologías o metrajes compró para continuar con la cotización de acabados.`;
            }

            return response;
        } catch (error) {
            logger.error('Error en buscarProyectoInmobiliarioTool:', error);
            return `Ocurrió un error consultando el proyecto "${nombre_proyecto}": ${error.message}. Continúa la conversación preguntándole al cliente los metros cuadrados de su apartamento.`;
        }
    },
    {
        name: "buscar_proyecto_inmobiliario",
        description: "Busca información oficial de un proyecto o conjunto residencial nuevo en Colombia, actualiza el contador de interesados del proyecto y registra la fecha de entrega del cliente. Úsala cuando el cliente mencione el nombre de su conjunto/proyecto o indique la fecha en que le entregan su apartamento.",
        schema: z.object({
            nombre_proyecto: z.string().describe("Nombre exacto del proyecto de vivienda o conjunto residencial (ejemplo: 'Paseo del Parque', 'Fontana Grande', 'Parque de las Flores', 'Hacienda El Otoño')."),
            fecha_entrega_cliente: z.string().optional().describe("Fecha en que la constructora le entrega el apartamento al cliente si la mencionó (ejemplo: 'Julio de 2027', 'segundo semestre 2026', 'noviembre 2026')."),
            ciudad: z.string().optional().describe("Ciudad o municipio del proyecto si el cliente lo mencionó (ejemplo: 'Bogotá', 'Chía', 'Cajicá', 'Mosquera', 'Madrid'). Por defecto 'Bogotá'.")
        })
    }
);
