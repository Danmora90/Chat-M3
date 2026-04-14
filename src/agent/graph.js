import { StateGraph, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentState } from "./state.js";
import { systemPrompt } from "../prompts/system.js";
import { materialSearchTool } from "../tools/materialSearch.js";
import { webSearchTool } from "../tools/webSearch.js";
import { updateUserDisplayNameTool } from "../tools/userProfile.js";
import { projectQuoterTool } from "../tools/projectQuoter.js";

import { processPaymentTool as registerSaleTool } from "../tools/paymentTools.js"; // Renamed import
import { updateChatTagTool } from "../tools/chatTaggingTool.js";
import { agendarReunionTool } from "../tools/calendarTool.js";
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
            agendarReunionTool
        ];
        const model = createOpenAIModel().bindTools(tools);

        /**
         * Nodo principal del agente - llama al modelo de OpenAI
         */
        async function callModel(state) {
            try {
                // --- CORRECCIÓN ARQUITECTÓNICA ---
                // Eliminamos cualquier manipulación manual del historial.
                // LangGraph gestiona state.messages y la persistencia (checkpoints).
                // Solo inyectamos el system prompt al vuelo (sin persistirlo).

                const messages = [
                    { role: "system", content: systemPrompt },
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
