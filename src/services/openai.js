import { ChatOpenAI } from "@langchain/openai";

/**
 * Crea y configura el modelo de OpenAI
 * @returns {ChatOpenAI} Modelo configurado
 */
export function createOpenAIModel() {
    return new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.7,
        openAIApiKey: process.env.OPENAI_API_KEY,
    });
}
