import { StateGraph, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentState } from "./state.js";
import { getSystemPrompt } from "../services/promptService.js";
import { materialSearchTool } from "../tools/materialSearch.js";
import { webSearchTool } from "../tools/webSearch.js";
import { updateUserDisplayNameTool } from "../tools/userProfile.js";
import { projectQuoterTool } from "../tools/projectQuoter.js";

import { processPaymentTool as registerSaleTool } from "../tools/paymentTools.js"; // Renamed import
import { updateChatTagTool } from "../tools/chatTaggingTool.js";
import { agendarReunionTool } from "../tools/calendarTool.js";
import { crmSyncTool } from "../tools/crmSyncTool.js";
import { buscarProyectoInmobiliarioTool } from "../tools/realEstateTool.js";
import { PostgresSaver } from "../checkpoints/postgresSaver.js";
import { createOpenAIModel } from "../services/openai.js";
import { logger } from "../middleware/logger.js";

/**
 * Helper seguro para resolver el tipo de mensaje (instancia LangChain vs Objeto plano)
 */
function resolveMessageType(message) {
    if (typeof message?.getType === "function") {
        return message.getType();
    }

    if (message?.role) {
        return message.role;
    }

    return null;
}

// Helper functions for history sanitization removed as they are no longer needed 
// with native LangGraph state management.

/**
 * Crea y configura el agente de LangGraph
 * @returns {Promise<CompiledGraph>} Agente compilado
 */
export async function createAgent() {
    try {
        // Configurar modelo con herramientas
        const tools = [
            materialSearchTool,
            webSearchTool,
            updateUserDisplayNameTool,
            projectQuoterTool,
            registerSaleTool,
            updateChatTagTool,
            agendarReunionTool,
            crmSyncTool,
            buscarProyectoInmobiliarioTool
        ];
        const model = createOpenAIModel().bindTools(tools);

        /**
         * Nodo principal del agente - llama al modelo de OpenAI
         */
        async function callModel(state) {
            try {
                // --- INYECCIÓN DE CONTEXTO TEMPORAL EN TIEMPO REAL Y TABLA DETERMINISTA ---
                const now = new Date();
                const bogotaDateStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota" });
                const baseDate = new Date(bogotaDateStr);

                const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
                const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

                const fechaActualFormatted = now.toLocaleString("es-CO", {
                    timeZone: "America/Bogota",
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: true
                });
                const isoActual = now.toISOString();

                // Construir tabla determinista de los próximos 14 días a partir de hoy (en hora de Colombia)
                let calendarTable = "CALENDARIO DETERMINISTA DE REFERENCIA (ZONA HORARIA COLOMBIA GMT-5):\n";
                for (let i = 0; i < 14; i++) {
                    const d = new Date(baseDate.getTime() + i * 24 * 3600 * 1000);
                    const year = d.getFullYear();
                    const monthName = months[d.getMonth()];
                    const monthNum = String(d.getMonth() + 1).padStart(2, '0');
                    const dayNum = String(d.getDate()).padStart(2, '0');
                    const dayName = days[d.getDay()];
                    
                    let label = "";
                    if (i === 0) label = " (HOY)";
                    else if (i === 1) label = " (MAÑANA)";
                    else if (i <= 7) label = " (ESTA SEMANA)";
                    else label = " (PRÓXIMA SEMANA)";

                    calendarTable += `- ${dayName.toUpperCase()} ${dayNum} de ${monthName} de ${year}${label} -> ISO Fecha: ${year}-${monthNum}-${dayNum}\n`;
                }

                const activePrompt = await getSystemPrompt();
                const dynamicSystemPrompt = `${activePrompt}

--------------------------------------------------
📌 REGLA SUPREMA TEMPORAL Y MANEJO DE MEMORIA (OBLIGATORIO):
1. FECHA Y HORA ACTUAL REAL EN COLOMBIA: ${fechaActualFormatted} (${isoActual}).
2. IGNORA COMPLETAMENTE cualquier año antiguo (como 2023 o 2024) o fecha equivocada que aparezca en el historial previo de mensajes de la memoria. NUNCA te bases en fechas de mensajes pasados.
3. Consulta la siguiente TABLA DETERMINISTA para saber la fecha ISO exactísima correspondiente a cualquier día mencionado por el usuario:

${calendarTable}

4. INSTRUCCIÓN PARA AGENDAR: Cuando el usuario diga "el martes", "mañana", "el próximo miércoles", busca el día exacto en la tabla determinista anterior y genera el parámetro fecha_hora_iso con el año ${now.getFullYear()} y la hora acordada (ejemplo: "${now.getFullYear()}-07-28T09:00:00-05:00").
--------------------------------------------------`;

                const messages = [
                    { role: "system", content: dynamicSystemPrompt },
                    ...state.messages
                ];

                logger.info('Calling OpenAI model', {
                    totalMessages: state.messages.length,
                    processedMessages: messages.length,
                    userId: state.userId
                });

                // LOG ESTRUCTURAL OBLIGATORIO PARA DEBUGGING OPENAI TOOL CALLS
                console.log(
                    "LLM Messages Payload:",
                    JSON.stringify(messages, null, 2)
                );

                const response = await model.invoke(messages);

                return { messages: [response] };
            } catch (error) {
                logger.error('Error calling model:', error);
                throw error;
            }
        }

        /**
         * Determina si el agente debe continuar ejecutando herramientas o terminar
         */
        function shouldContinue(state) {
            const lastMessage = state.messages[state.messages.length - 1];

            // Si el modelo quiere usar herramientas, continuar al nodo de tools
            if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
                logger.info('Agent requesting tools', {
                    toolCalls: lastMessage.tool_calls.map(tc => tc.name)
                });
                return "tools";
            }

            // Si no, terminar
            return END;
        }

        // Crear nodo de herramientas
        const toolNode = new ToolNode(tools);

        // Construir el grafo
        const workflow = new StateGraph(AgentState)
            .addNode("agent", callModel)
            .addNode("tools", toolNode)
            .addEdge("__start__", "agent")
            .addConditionalEdges("agent", shouldContinue)
            .addEdge("tools", "agent");

        // Configurar checkpointer con PostgresSaver
        const checkpointer = await PostgresSaver.fromConnString(
            process.env.SUPABASE_URL
        );

        logger.info('Agent graph created successfully');

        // Compilar y retornar el grafo
        return workflow.compile({ checkpointer });
    } catch (error) {
        logger.error('Error creating agent:', error);
        throw error;
    }
}

// Variable global para mantener la instancia del agente
let agentInstance = null;

/**
 * Obtiene la instancia del agente (singleton)
 */
export async function getAgent() {
    if (!agentInstance) {
        agentInstance = await createAgent();
    }
    return agentInstance;
}
