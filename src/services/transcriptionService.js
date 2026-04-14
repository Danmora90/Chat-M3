import OpenAI from 'openai';
import fs from 'fs';
import { logger } from '../middleware/logger.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Transcribe un archivo de audio usando OpenAI Whisper
 * @param {string} filePath - Ruta del archivo de audio local
 * @returns {Promise<string>} Texto transcrito
 */
export async function transcribeAudio(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Audio file not found at ${filePath}`);
        }

        logger.info('Starting audio transcription with Whisper', { filePath });

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            language: "es", // Forzamos español, o dejamos auto si preferimos
        });

        logger.info('Transcription completed', { textLength: transcription.text.length });
        
        return transcription.text;

    } catch (error) {
        logger.error('Error in transcribeAudio:', error);
        // Retornar string vacío o error controlado para no romper flujo
        return ""; 
    }
}
