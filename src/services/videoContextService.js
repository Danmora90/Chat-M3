import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import OpenAI from 'openai';
import { logger } from '../middleware/logger.js';
import { processVideo, cleanupTempFiles } from '../utils/mediaProcessor.js';
import { transcribeAudio } from './transcriptionService.js';
import { supabaseAdmin } from './supabase.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Caché en memoria para evitar llamadas redundantes de IA por el mismo video/post
const contextCache = new Map();

/**
 * Obtiene o genera el análisis y contexto detallado de un video o publicación
 * @param {Object} params
 * @param {string} params.mediaId - ID del medio o post
 * @param {string} [params.mediaUrl] - URL de la imagen/miniatura
 * @param {string} [params.videoUrl] - URL del archivo de video MP4 si está disponible
 * @param {string} [params.caption] - Texto/caption original de la publicación
 * @param {string} [params.platform] - 'instagram' o 'facebook'
 * @returns {Promise<Object>} Objeto con summary, transcription, visual_elements, space
 */
export async function getVideoContext({ mediaId, mediaUrl, videoUrl, caption, platform = 'instagram' }) {
    if (!mediaId) return null;

    // 1. Revisar caché en memoria
    if (contextCache.has(mediaId)) {
        logger.debug('Video context retrieved from memory cache', { mediaId });
        return contextCache.get(mediaId);
    }

    // 2. Revisar si ya fue analizado previamente en la base de datos (mensajes anteriores)
    try {
        const { data: previousMsg } = await supabaseAdmin
            .from('messages')
            .select('metadata')
            .contains('metadata', { post_id: mediaId })
            .not('metadata->video_analysis', 'is', null)
            .limit(1)
            .maybeSingle();

        if (previousMsg?.metadata?.video_analysis) {
            logger.info('Video context retrieved from database cache', { mediaId });
            const savedAnalysis = previousMsg.metadata.video_analysis;
            contextCache.set(mediaId, savedAnalysis);
            return savedAnalysis;
        }
    } catch (dbErr) {
        logger.warn('Could not check database for existing video context', { error: dbErr.message });
    }

    logger.info('Generating new video/post context analysis', { mediaId, hasVideoUrl: !!videoUrl, hasMediaUrl: !!mediaUrl });

    let transcription = '';
    let visualDescription = '';
    let visualElements = [];
    let space = '';
    let summary = '';
    let finalAnalysisResult = null;
    const tempFiles = [];

    // 3. Si hay video MP4 disponible, transcribir el audio usando Whisper
    if (videoUrl && (videoUrl.includes('.mp4') || videoUrl.includes('fna.fbcdn.net') || videoUrl.includes('cdninstagram.com'))) {
        try {
            logger.info('Downloading video for audio transcription', { mediaId });
            const tempVideoPath = path.join(os.tmpdir(), `meta_vid_${mediaId}_${Date.now()}.mp4`);
            
            const response = await axios.get(videoUrl, {
                responseType: 'stream',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const writer = fs.createWriteStream(tempVideoPath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            tempFiles.push(tempVideoPath);

            // Extraer audio con ffmpeg
            const { audioPath, frames } = await processVideo(tempVideoPath);
            if (audioPath) tempFiles.push(audioPath);
            if (frames && frames.length > 0) tempFiles.push(...frames);

            if (audioPath) {
                transcription = await transcribeAudio(audioPath);
                logger.info('Video transcribed successfully with Whisper', { mediaId, length: transcription.length });
            }
        } catch (videoErr) {
            logger.warn('Could not transcribe video file, falling back to visual analysis', {
                mediaId,
                error: videoErr.message
            });
        } finally {
            if (tempFiles.length > 0) {
                await cleanupTempFiles(tempFiles).catch(() => {});
            }
        }
    }

    // 4. Si hay imagen/miniatura, analizar visualmente con GPT-4o
    if (mediaUrl) {
        try {
            logger.info('Analyzing post/reel thumbnail with GPT-4o vision', { mediaId });
            const imgRes = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const base64Image = Buffer.from(imgRes.data).toString('base64');

            const visionPrompt = `Esta imagen es la portada o miniatura de un Reel/video publicado por MAS.3 (empresa de arquitectura, diseño de interiores, remodelaciones y fabricación de mobiliario a medida).
${caption ? `El título o texto oficial de la publicación en redes es: "${caption}".` : ''}
${transcription ? `El audio hablado en el video dice: "${transcription}".` : ''}

REGLAS CRÍTICAS DE INTERPRETACIÓN:
- El título/caption de la publicación define el tema principal del proyecto (ej. remodelación integral de apartamento, proyecto inmobiliario, diseño de interiores). No limites el proyecto a una sola habitación o mueble solo porque aparezca en este fotograma específico.
- Extrae cualquier texto, letrero, medidas o stickers sobrepuestos en la imagen (OCR).

Analiza la imagen e identifica detalladamente:
1. "project_title": Nombre del proyecto o remodelación si se menciona en el título o en la imagen (ej. "Meridiano 3026 (26 m²)").
2. "text_overlay": Textos, medidas o títulos escritos sobre la imagen (ej. "Remodelación 26m2", "Meridiano 3026").
3. "space": El espacio o ambiente mostrado en este fotograma específico (ej. apartamento completo, cocina, baño, sala, habitación, etc.).
4. "visual_elements": Acabados, materiales, muebles o productos visibles (ej. grifería, estantes, porcelanato, enchapes, tubería, etc.).
5. "visual_description": Descripción visual concisa del fotograma.
6. "summary": Un resumen claro, profesional y completo (en 1 o 2 frases) de qué proyecto, servicio o remodelación se promociona o muestra en este video/publicación, integrando el título oficial y los elementos visibles.

Responde ÚNICAMENTE en formato JSON con la siguiente estructura:
{
  "project_title": "...",
  "text_overlay": "...",
  "space": "...",
  "visual_elements": ["...", "..."],
  "visual_description": "...",
  "summary": "..."
}`;

            const visionResponse = await openai.chat.completions.create({
                model: 'gpt-4o',
                response_format: { type: 'json_object' },
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: visionPrompt },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                }],
                max_tokens: 500,
                temperature: 0.3
            });

            const resultJson = JSON.parse(visionResponse.choices[0]?.message?.content || '{}');
            space = resultJson.space || '';
            visualElements = resultJson.visual_elements || [];
            visualDescription = resultJson.visual_description || '';
            summary = resultJson.summary || '';
            const textOverlay = resultJson.text_overlay || '';
            const projectTitle = resultJson.project_title || '';

            finalAnalysisResult = {
                summary: summary || (caption ? `Publicación sobre: ${caption}` : 'Publicación de arquitectura y remodelación.'),
                project_title: projectTitle || null,
                text_overlay: textOverlay || null,
                transcription: transcription || null,
                visual_elements: visualElements,
                visual_description: visualDescription || null,
                space: space || null
            };

        } catch (visionErr) {
            logger.warn('Could not analyze post thumbnail with GPT-4o vision', {
                mediaId,
                error: visionErr.message
            });
        }
    }

    // 5. Si no se generó summary con visión pero hay transcripción o caption
    if (!summary && transcription) {
        summary = `Video explicativo donde se habla de: ${transcription.slice(0, 200)}...`;
    } else if (!summary && caption) {
        summary = `Publicación sobre: ${caption}`;
    }

    const finalAnalysis = finalAnalysisResult || {
        summary: summary || (caption ? `Publicación sobre: ${caption}` : 'Publicación/Reel de arquitectura y remodelación.'),
        project_title: null,
        text_overlay: null,
        transcription: transcription || null,
        visual_elements: visualElements,
        visual_description: visualDescription || null,
        space: space || null
    };

    // 6. Guardar en caché en memoria
    contextCache.set(mediaId, finalAnalysis);
    logger.info('Video context analysis completed and cached', { mediaId, hasTranscription: !!transcription, summary: finalAnalysis.summary });

    return finalAnalysis;
}
