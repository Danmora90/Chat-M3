import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { logger } from '../middleware/logger.js';

const streamPipeline = promisify(pipeline);

// Configurar ffmpeg con el path estático
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

/**
 * Procesa un archivo de video local para extraer audio y frames
 * @param {string} localFilePath - Ruta del archivo de video
 * @returns {Promise<{audioPath: string, frames: string[]}>} Rutas a los archivos generados
 */
export async function processVideo(localFilePath) {
    const tempDir = os.tmpdir();
    const baseName = path.basename(localFilePath, path.extname(localFilePath));
    const audioPath = path.join(tempDir, `${baseName}_audio.mp3`);
    const framesPattern = path.join(tempDir, `${baseName}_frame_%d.jpg`);
    
    logger.info('Starting video processing', { localFilePath });

    try {
        // 1. Extraer Audio
        await new Promise((resolve, reject) => {
            ffmpeg(localFilePath)
                .toFormat('mp3')
                .on('error', (err) => reject(new Error(`Error extracting audio: ${err.message}`)))
                .on('end', () => resolve())
                .save(audioPath);
        });
        logger.debug('Audio extracted successfully', { audioPath });

        // 2. Extraer Frames (Keyframes representativos)
        // Extraemos 3 frames (al 20%, 50% y 80% del video)
        // Nota: fluent-ffmpeg screenshots es asíncrono.
        
        // Primero obtenemos duración para calcular timestamps
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(localFilePath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
            });
        });

        const duration = metadata.format.duration || 0;
        const timestamps = [
            duration * 0.2, // 20%
            duration * 0.5, // 50%
            duration * 0.8  // 80%
        ];

        const frames = [];

        await new Promise((resolve, reject) => {
            ffmpeg(localFilePath)
                .on('error', (err) => reject(new Error(`Error extracting frames: ${err.message}`)))
                .on('end', () => resolve())
                .screenshots({
                    count: 3,
                    timemarks: timestamps.map(t => t.toString()),
                    filename: `${baseName}_frame_%01d.jpg`,
                    folder: tempDir,
                    size: '512x?' // Redimensionar para reducir tokens, manteniendo aspect ratio
                });
        });

        // Recuperar los nombres de archivos generados
        // fluent-ffmpeg naming convention with %01d: frame_1.jpg, frame_2.jpg, etc.
        for (let i = 1; i <= 3; i++) {
            const framePath = path.join(tempDir, `${baseName}_frame_${i}.jpg`);
            if (fs.existsSync(framePath)) {
                frames.push(framePath);
            }
        }
        
        logger.debug('Frames extracted successfully', { count: frames.length });

        return {
            audioPath,
            frames
        };

    } catch (error) {
        logger.error('Error processing video:', error);
        throw error;
    }
}

/**
 * Limpia los archivos temporales generados
 * @param {string[]} filePaths 
 */
export async function cleanupTempFiles(filePaths) {
    for (const file of filePaths) {
        if (file && fs.existsSync(file)) {
            try {
                await fs.promises.unlink(file);
            } catch (err) {
                console.error(`Error deleting temp file ${file}:`, err);
            }
        }
    }
}

/**
 * Descarga un archivo multimedia público (Meta CDN, etc.) a un archivo temporal local
 * @param {string} mediaUrl - URL del archivo
 * @param {string} localPath - Ruta local de destino
 * @returns {Promise<string>} Ruta local del archivo descargado
 */
export async function downloadPublicMediaToFile(mediaUrl, localPath) {
    try {
        const response = await axios.get(mediaUrl, {
            responseType: 'stream',
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            validateStatus: (status) => status >= 200 && status < 300
        });

        await streamPipeline(response.data, fs.createWriteStream(localPath));
        return localPath;
    } catch (error) {
        logger.error('Error downloading public media to file:', { mediaUrl, error: error.message });
        throw error;
    }
}

/**
 * Descarga un archivo multimedia público como Buffer con su Content-Type
 * @param {string} mediaUrl - URL del archivo
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function downloadPublicMediaBuffer(mediaUrl) {
    try {
        const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: 25000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            validateStatus: (status) => status >= 200 && status < 300
        });

        return {
            buffer: Buffer.from(response.data),
            contentType: String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
        };
    } catch (error) {
        logger.error('Error downloading public media buffer:', { mediaUrl, error: error.message });
        throw error;
    }
}
