import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "../services/supabase.js";

const BASE_M2 = 1000000; // Cálculo interno base por metro cuadrado (no mencionar al cliente)
const MARGEN_MIN = 8000000;  // 8 millones COP
const MARGEN_MAX = 16000000; // 16 millones COP

export const projectQuoterTool = tool(
    async ({ metros_cuadrados, presupuesto_disponible }, config) => {
        try {
            const m2 = Number(metros_cuadrados);

            if (isNaN(m2) || m2 <= 0) {
                return "Error: Por favor, proporciona un área en metros cuadrados válida y mayor a cero.";
            }

            const baseCost = m2 * BASE_M2;
            const rangoMin = baseCost + MARGEN_MIN;
            const rangoMax = baseCost + MARGEN_MAX;
            const presupuesto = (presupuesto_disponible && !isNaN(Number(presupuesto_disponible))) ? Number(presupuesto_disponible) : null;
            const isViable = presupuesto ? (presupuesto >= rangoMin) : true;
            const areaViable = (!isViable && presupuesto) ? Math.floor(presupuesto / BASE_M2) : m2;

            // Persistir en Supabase si se provee thread_id / chatId
            const threadId = config.configurable?.thread_id;
            if (threadId) {
                const chatId = threadId.replace('conversation_', '');
                
                // Actualizar o crear proyecto
                const { data: existingProject } = await supabaseAdmin
                    .from('projects')
                    .select('id')
                    .eq('chat_id', chatId)
                    .maybeSingle();

                const targetStage = !isViable ? '1 - No tiene presupuesto' : '6 - Lead';

                const projectPayload = {
                    chat_id: chatId,
                    total_area_m2: m2,
                    budget_total: presupuesto,
                    is_viable: isViable,
                    area_viable_m2: areaViable,
                    valor_cotizado_min: rangoMin,
                    valor_cotizado_max: rangoMax,
                    estatus_embudo: targetStage,
                    updated_at: new Date().toISOString()
                };

                if (existingProject?.id) {
                    await supabaseAdmin.from('projects').update(projectPayload).eq('id', existingProject.id);
                } else {
                    await supabaseAdmin.from('projects').insert(projectPayload);
                }

                // Actualizar estado de la conversación en chats
                await supabaseAdmin
                    .from('chats')
                    .update({
                        funnel_stage: targetStage,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', chatId);
            }

            let respuesta = `📊 **Resultados de la Cotización Estimada:**\n`;
            respuesta += `- Área a remodelar: ${m2} m²\n`;
            respuesta += `- Rango estimado de remodelación integral: $${rangoMin.toLocaleString('es-CO')} a $${rangoMax.toLocaleString('es-CO')} COP\n\n`;

            if (presupuesto && presupuesto > 0) {
                respuesta += `- Presupuesto proporcionado por el cliente: $${presupuesto.toLocaleString('es-CO')} COP\n`;

                if (presupuesto >= rangoMin) {
                    respuesta += `✅ **Viabilidad:** El presupuesto del cliente está dentro o por encima del rango estimado. Invítalo a agendar una videollamada para definir materiales y acabados exactos.`;
                } else {
                    respuesta += `⚠️ **Viabilidad:** El presupuesto está por debajo del rango estimado completo. Sugiérele revisar el alcance del proyecto o agendar una cita para ver alternativas según su presupuesto.`;
                }
            } else {
                respuesta += `💡 **Instrucción para el Agente Felipe:**\n`;
                respuesta += `1. Si el cliente aún NO ha mencionado su presupuesto, pregúntale primero cuál es el presupuesto que tiene destinado.\n`;
                respuesta += `2. Si el cliente no desea dar su presupuesto o pide el estimado de una vez, comunícale que el costo estimado para la remodelación integral de su espacio de ${m2} m² está entre **$${rangoMin.toLocaleString('es-CO')} y $${rangoMax.toLocaleString('es-CO')} COP**.\n`;
                respuesta += `3. Explícale que la variación entre esos valores depende exclusivamente de los materiales y acabados que se escojan en una reunión virtual o visita técnica. NUNCA menciones tarifas fijas por metro cuadrado.`;
            }

            return respuesta;
        } catch (error) {
            return `Ocurrió un error al calcular la cotización: ${error.message}`;
        }
    },
    {
        name: "project_quotation_calculator",
        description: "Úsala para calcular el rango de inversión estimado para remodelación integral según los metros cuadrados del inmueble. El presupuesto del cliente es opcional.",
        schema: z.object({
            metros_cuadrados: z.number().describe("Cantidad de metros cuadrados (m²) que el cliente desea remodelar."),
            presupuesto_disponible: z.number().optional().describe("Presupuesto opcional en pesos (COP) del que dispone el cliente si lo proporcionó.")
        })
    }
);

