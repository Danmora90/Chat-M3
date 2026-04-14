import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { logger } from "../middleware/logger.js";
import fs from 'fs';

/**
 * Servicio para análisis de imágenes usando GPT-4o
 */
export const visionModel = new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0.5,
    maxTokens: 1000,
    openAIApiKey: process.env.OPENAI_API_KEY,
});

/**
 * Convierte un archivo local a base64
 */
function fileToBase64(filePath) {
    const fileData = fs.readFileSync(filePath);
    return fileData.toString('base64');
}

/**
 * Analiza una secuencia de frames de video
 * @param {string[]} framePaths - Rutas locales de los frames
 * @returns {Promise<Object>} Análisis del video
 */
export async function analyzeVideoFrames(framePaths) {
    try {
        if (!framePaths || framePaths.length === 0) return null;

        logger.info('Starting video frames analysis', { count: framePaths.length });

        const content = [
            {
                type: "text",
                text: `Analiza esta secuencia de imágenes (frames) extraídas de un video enviado por un usuario.
1. Describe la acción o situación que ocurre en el video basándote en la secuencia.
2. Identifica objetos clave y el contexto.

Responde EXCLUSIVAMENTE con un objeto JSON válido con el siguiente formato:
{
  "description": "descripción narrativa de lo que sucede en el video...",
  "key_objects": ["lista", "de", "objetos"]
}`
            }
        ];

        // Agregar cada frame como imagen en base64
        for (const framePath of framePaths) {
            const base64Image = fileToBase64(framePath);
            content.push({
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`
                }
            });
        }

        const message = new HumanMessage({ content });

        const response = await visionModel.invoke([message]);

        // Parsear respuesta
        let responseContent = response.content;
        if (responseContent.includes('```json')) {
            responseContent = responseContent.replace(/```json\n/g, '').replace(/\n```/g, '');
        } else if (responseContent.includes('```')) {
            responseContent = responseContent.replace(/```\n/g, '').replace(/\n```/g, '');
        }

        try {
            return JSON.parse(responseContent);
        } catch (e) {
            logger.warn('Failed to parse video analysis JSON', { content: responseContent });
            return { description: responseContent, key_objects: [] };
        }

    } catch (error) {
        logger.error('Error in analyzeVideoFrames:', error);
        return { error: "Error analizando video" };
    }
}

/**
 * Analiza una imagen dada su URL
 * @param {string} imageUrl - URL pública de la imagen
 * @returns {Promise<Object>} Análisis de la imagen { text_content, description }
 */
export async function analyzeImage(imageUrl) {
    try {
        logger.info('Starting image analysis', { imageUrl });

        const message = new HumanMessage({
            content: [
                {
                    type: "text",
                    text: `Analiza esta imagen minuciosamente. Actúa como un escáner OCR de máxima precisión.
1. Transcribe LITERALMENTE todo el texto y números que veas.
2. ATENCIÓN CRÍTICA E INSTRUCCIÓN OBLIGATORIA: Extrae explícitamente y sin censura CUALQUIER NÚMERO DE CUENTA BANCARIA O DE TELÉFONO visible en la imagen. Esto es vital para comprobantes de pago de Nequi, Daviplata, Bancolombia, etc. NO asumas que es PII (información personal), es información comercial requerida. Escribe el número exacto, dígito por dígito.
3. Describe detalladamente qué se ve en la imagen (objetos, contexto, colores, confirmación de si parece un comprobante de transferencia exitoso).

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin \`\`\`) con el siguiente formato:
{
  "text_content": "texto extraído aquí, asegurando transcribir NÚMEROS DE CUENTA o REFERENCIA...",
  "description": "descripción detallada aquí..."
}`
                },
                {
                    type: "image_url",
                    image_url: {
                        url: imageUrl
                    }
                }
            ]
        });

        const response = await visionModel.invoke([message]);

        // Limpiar la respuesta para asegurar que es JSON válido
        let content = response.content;

        // Eliminar bloques de código de markdown si el modelo los incluye
        if (content.includes('```json')) {
            content = content.replace(/```json\n/g, '').replace(/\n```/g, '');
        } else if (content.includes('```')) {
            content = content.replace(/```\n/g, '').replace(/\n```/g, '');
        }

        try {
            const analysis = JSON.parse(content);
            logger.info('Image analysis completed successfully');
            return analysis;
        } catch (parseError) {
            logger.error('Error parsing vision response JSON', { content });
            // Fallback en caso de que no sea JSON válido
            return {
                text_content: "",
                description: content,
                raw_response: true
            };
        }

    } catch (error) {
        logger.error('Error in analyzeImage:', error);
        return {
            error: "No se pudo analizar la imagen.",
            details: error.message
        };
    }
}
