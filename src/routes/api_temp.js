import express from 'express';
import { supabaseAdmin, getChatHistory, getOrCreateChat, getOrCreateUser } from '../services/supabase.js';
import { getSignedUrl as getFirebaseSignedUrl } from '../services/firebase.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();

/**
 * Endpoint para renovar URLs firmadas de adjuntos (imágenes/archivos)
 * Útil cuando la URL original ha expirado en el frontend
 */
router.post('/attachments/refresh', catchAsync(async (req, res) => {
    const { storage_path, storage_provider } = req.body;

    if (!storage_path) {
        return res.status(400).json({ error: "Missing storage_path" });
    }

    try {
        let signedUrl;
        let expiresAt;

        // Determinar proveedor (por defecto asumir firebase si el path parece de firebase o se especifica)
        // Ojo: En tu lógica actual guardas 'storage_provider': 'firebase' en metadata
        const isFirebase = storage_provider === 'firebase' || !storage_path.startsWith('chat-media/');

        if (isFirebase) {
             const result = await getFirebaseSignedUrl(storage_path, 7); // 7 días
             signedUrl = result.signedUrl;
             expiresAt = result.expiresAt;
        } else {
            // Fallback para archivos antiguos en Supabase Storage
            const { data, error } = await supabaseAdmin.storage
                .from('chat-media')
                .createSignedUrl(storage_path, 3600); // 1 hora
            
            if (error) throw error;
            signedUrl = data.signedUrl;
            // Supabase createSignedUrl no devuelve expiresAt exacto en data, calculamos aprox
            const date = new Date();
            date.setSeconds(date.getSeconds() + 3600);
            expiresAt = date.toISOString();
        }

        return res.json({ 
            url: signedUrl, 
            expires_at: expiresAt 
        });

    } catch (error) {
        logger.error('Error refreshing attachment URL:', { error: error.message, storage_path });
        return res.status(500).json({ error: "Failed to refresh URL" });
    }
}));

// ... (resto de endpoints existentes se mantienen abajo o los importamos si vamos a sobreescribir)
