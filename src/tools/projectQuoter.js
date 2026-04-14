import { tool } from "@langchain/core/tools";
import { z } from "zod";

const COSTO_POR_M2 = 1000000; // 1 millón COP por metro cuadrado

export const projectQuoterTool = tool(
    async ({ metros_cuadrados, presupuesto_disponible }, config) => {
        try {
            const m2 = Number(metros_cuadrados);
            const presupuesto = Number(presupuesto_disponible);

            if (isNaN(m2) || m2 <= 0) {
                return "Error: Por favor, proporciona un área en metros cuadrados válida y mayor a cero.";
            }

            if (isNaN(presupuesto) || presupuesto <= 0) {
                return "Error: Por favor, proporciona un presupuesto válido en pesos (COP).";
            }

            const costoTotalEstimado = m2 * COSTO_POR_M2;
            let respuesta = `📊 **Resultados de la Cotización Estimada:**\n`;
            respuesta += `- Área requerida: ${m2} m²\n`;
            respuesta += `- Presupuesto del cliente: $${presupuesto.toLocaleString('es-CO')}\n`;
            respuesta += `- Costo Total Estimado: $${costoTotalEstimado.toLocaleString('es-CO')}\n\n`;

            // Aquí idealmente deberíamos retornar esto al LLM y actualizar el estado
            // LangGraph puede inyectar esto en el prompt. El reducer del estado puede ser llamado
            // desde un Command si estamos en LangGraph v0.2+, pero como tool simple devolvemos el texto
            // para que Mas3 se lo comunique al cliente.

            if (presupuesto >= costoTotalEstimado) {
                respuesta += `✅ **Viabilidad:** El presupuesto es **Suficiente**. La obra es completamente realizable con el dinero disponible. Puedes invitar al cliente a agendar una visita técnica o realizar el pago del anticipo de obra.`;
            } else {
                const areaViable = Math.floor(presupuesto / COSTO_POR_M2);
                respuesta += `⚠️ **Viabilidad:** El presupuesto es **Insuficiente** para los ${m2} m² solicitados.\n`;
                
                if (areaViable > 0) {
                    respuesta += `💡 **Alternativa Sugerida:** Con el presupuesto actual, el cliente podría remodelar un área de **${areaViable} m²**. Sugiérele iniciar el proyecto por fases (ej: primero baños o cocina).`;
                } else {
                    respuesta += `🛑 **Importante:** El presupuesto no alcanza ni para el área mínima de 1 m². Informa amablemente al cliente sobre nuestras tarifas de $1,000,000 COP por metro cuadrado.`;
                }
            }

            return respuesta;
        } catch (error) {
            return `Ocurrió un error al calcular la cotización: ${error.message}`;
        }
    },
    {
        name: "project_quotation_calculator",
        description: "Úsala cuando el cliente proporciona los metros cuadrados (m²) a remodelar y su presupuesto disponible. Calcula si el presupuesto es viable o cuántos metros se pueden hacer con su dinero.",
        schema: z.object({
            metros_cuadrados: z.number().describe("Cantidad de metros cuadrados (m²) que el cliente desea remodelar."),
            presupuesto_disponible: z.number().describe("Presupuesto en pesos (COP) del que dispone el cliente.")
        })
    }
);
