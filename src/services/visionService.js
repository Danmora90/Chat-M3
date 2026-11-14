import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { logger } from "../middleware/logger.js";
import fs from 'fs';
import axios from 'axios';

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
 * Analiza una imagen dada su URL o Data URI (base64)
 * @param {string} imageUrlOrBase64 - URL pública o Data URI de la imagen
 * @returns {Promise<Object>} Análisis de la imagen { text_content, description, space_type, is_blueprint }
 */
export async function analyzeImage(imageUrlOrBase64) {
    try {
        if (!imageUrlOrBase64) return null;
        logger.info('Starting image analysis', { isUrl: imageUrlOrBase64.startsWith('http') });

        let finalImageUrl = imageUrlOrBase64;

        // Si es una URL HTTP(S) (por ejemplo CDN de Meta o Twilio), descargar primero a base64
        // para evitar bloqueos HTTP 403 de Meta hacia los servidores de OpenAI
        if (imageUrlOrBase64.startsWith('http://') || imageUrlOrBase64.startsWith('https://')) {
            try {
                const response = await axios.get(imageUrlOrBase64, {
                    responseType: 'arraybuffer',
                    timeout: 20000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const contentType = String(response.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
                const base64Data = Buffer.from(response.data).toString('base64');
                finalImageUrl = `data:${contentType};base64,${base64Data}`;
            } catch (dlErr) {
                logger.warn('Could not pre-download image for vision, attempting direct URL', { error: dlErr.message });
                finalImageUrl = imageUrlOrBase64;
            }
        }

        const message = new HumanMessage({
            content: [
                {
                    type: "text",
                    text: `Analiza esta imagen minuciosamente actuando como un arquitecto experto de MAS.3 y escáner OCR de máxima precisión.

1. Identifica el TIPO DE CONTENIDO:
   - ¿Es un PLANO ARQUITECTÓNICO? (distribución de apartamento, cotas, medidas, nombres de áreas).
   - ¿Es la FOTO DE UN ESPACIO REAL? (obra gris, sala, cocina, baño, alcoba, balcón, fachada, acabados actuales).
   - ¿Es una FOTO DE REFERENCIA O DISEÑO? (render 3D, foto de revista o catálogo de diseño).
   - ¿Es un COMPROBANTE DE PAGO O DOCUMENTO? (transferencia Nequi, Daviplata, Bancolombia, cotización, etc.).
   - ¿Es otro tipo de imagen?

2. Transcribe LITERALMENTE todo el texto, números, cotas o medidas que veas (si es comprobante, extrae cuenta, valor, fecha y referencia exactos).
3. Si es un plano o espacio, describe los materiales, iluminación, distribución y potencial de remodelación con visión arquitectónica.

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin \`\`\`) con el siguiente formato:
{
  "is_blueprint": false,
  "space_type": "cocina|baño|sala|alcoba|balcon|plano|comprobante|otro",
  "text_content": "texto extraído aquí, cotas, medidas, valores...",
  "description": "descripción arquitectónica y visual detallada del espacio o plano...",
  "summary": "resumen en 1 frase para que el asesor IA responda con total conocimiento de lo que el cliente envió"
}`
                },
                {
                    type: "image_url",
                    image_url: {
                        url: finalImageUrl
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
            logger.info('Image analysis completed successfully', {
                space_type: analysis.space_type,
                is_blueprint: analysis.is_blueprint
            });
            return analysis;
        } catch (parseError) {
            logger.error('Error parsing vision response JSON', { content });
            return {
                is_blueprint: false,
                space_type: "otro",
                text_content: "",
                description: content,
                summary: content,
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
