import { Annotation } from "@langchain/langgraph";

/**
 * Define el estado del agente siguiendo el patrón de LangGraph
 * Este estado se mantiene a lo largo de toda la conversación
 */
export const AgentState = Annotation.Root({
    // Array de mensajes de la conversación
    messages: Annotation({
        reducer: (current, update) => [...current, ...update],
        default: () => []
    }),

    // Número de teléfono del usuario (identificador único)
    userPhone: Annotation({
        reducer: (current, update) => update ?? current,
        default: () => null
    }),

    // ID de la conversación (legacy) en Supabase
    // Se mantiene por compatibilidad con checkpoints antiguos.
    conversationId: Annotation({
        reducer: (current, update) => update ?? current,
        default: () => null
    }),

    // ID del chat en Supabase (preferido)
    chatId: Annotation({
        reducer: (current, update) => update ?? current,
        default: () => null
    }),

    // ID del usuario en Supabase
    userId: Annotation({
        reducer: (current, update) => update ?? current,
        default: () => null
    }),

    // Contexto del proyecto de remodelación
    projectContext: Annotation({
        reducer: (current, update) => {
            if (!update) return current;
            return { ...(current || {}), ...update };
        },
        default: () => ({
            metrosCuadrados: null,
            presupuesto: null,
            esViable: null,
            areaViable: null,
            funnelStage: '1 - Lead',
            valorCotizadoMin: null,
            valorCotizadoMax: null,
            nextAction: null,
            fechaEntregaConstructora: null,
            observaciones: null
        })
    })
});
