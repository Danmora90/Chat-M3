import express from 'express';
import { authMiddleware, requireRole } from '../middleware/authMiddleware.js';
import { supabaseAdmin, getChatHistory, saveMessage } from '../services/supabase.js';
import { getSignedUrl as getFirebaseSignedUrl } from '../services/firebase.js';
import { sendWhatsAppMessage } from '../services/twilio.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';
import { salesService } from '../services/salesService.js';
import { uploadFile } from '../services/firebase.js';
import axios from 'axios';
import multer from 'multer';

// Middleware para manejo de ficheros en memoria
const uploadMiddleware = multer({ storage: multer.memoryStorage() });

const router = express.Router();

/**
 * Endpoint para renovar URLs firmadas de adjuntos (imágenes/archivos)
 * Útil cuando la URL original ha expirado en el frontend.
 * Autenticación opcional para permitir refresh rápido, o activar si se prefiere.
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
        const isFirebase = storage_provider === 'firebase' || !storage_path.startsWith('chat-media/');

        if (isFirebase) {
            const result = await getFirebaseSignedUrl(storage_path, 7); // 7 días
            signedUrl = result.signedUrl;
            expiresAt = result.expiresAt;
        } else {
            // Fallback para archivos antiguos en Supabase Storage
            const { data, error } = await supabaseAdmin.storage
                .from('chat-media')
                .createSignedUrl(storage_path, 3600); // 1 hora de defecto si no se puede más

            if (error) throw error;
            signedUrl = data.signedUrl;
            // Supabase createSignedUrl no devuelve expiresAt, calculamos:
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

/**
 * GET /api/media/proxy
 * Proxy para servir media de Twilio con autenticación
 */
router.get('/media/proxy', authMiddleware, catchAsync(async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    if (parsedUrl.username || parsedUrl.password) {
        return res.status(400).json({ error: 'URL credentials are not allowed' });
    }

    if (parsedUrl.protocol !== 'https:') {
        return res.status(403).json({ error: 'Only https URLs are allowed' });
    }

    const allowedHosts = (process.env.TWILIO_MEDIA_HOSTS || 'api.twilio.com')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean);

    const hostname = parsedUrl.hostname.toLowerCase();
    if (!allowedHosts.includes(hostname)) {
        return res.status(403).json({ error: 'Only Twilio media hosts can be proxied' });
    }

    logger.debug('Proxying Twilio media', {
        url: parsedUrl.toString(),
        hostname,
        path: parsedUrl.pathname
    });

    try {
        const maxBytes = parseInt(process.env.MEDIA_PROXY_MAX_BYTES || '15728640'); // 15MB
        const start = Date.now();

        let response = await axios.get(parsedUrl.toString(), {
            responseType: 'stream',
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            },
            timeout: parseInt(process.env.MEDIA_PROXY_TIMEOUT_MS || '10000'),
            maxRedirects: 0, // No seguir automáticamente para evitar enviar auth headers al destino (S3)
            validateStatus: (status) => status >= 200 && status < 400
        });

        // Si Twilio redirige (status 3xx), seguir la redirección sin credenciales
        // Esto es necesario porque Twilio suele redirigir a URLs firmadas de S3 que rechazan Basic Auth
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            const redirectUrl = response.headers.location;
            logger.debug('Twilio media returned redirect, following to new location', {
                originalUrl: parsedUrl.toString(),
                redirectUrl
            });

            response = await axios.get(redirectUrl, {
                responseType: 'stream',
                timeout: parseInt(process.env.MEDIA_PROXY_TIMEOUT_MS || '10000'),
                maxRedirects: 5
                // Nota: NO incluimos auth aquí
            });
        }

        const contentLengthHeader = response.headers['content-length'];
        const contentLength = contentLengthHeader ? parseInt(contentLengthHeader) : null;
        if (contentLength && contentLength > maxBytes) {
            logger.warn('Proxy blocked media due to size', {
                hostname,
                contentLength,
                maxBytes
            });
            return res.status(413).json({ error: 'Media too large' });
        }

        // Set headers
        res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        let transferred = 0;
        response.data.on('data', (chunk) => {
            transferred += chunk.length;
            if (transferred > maxBytes) {
                logger.warn('Proxy aborted media stream due to size', {
                    hostname,
                    transferred,
                    maxBytes
                });
                response.data.destroy();
                res.destroy();
            }
        });

        response.data.on('end', () => {
            const durationMs = Date.now() - start;
            logger.info('Proxied Twilio media', {
                hostname,
                transferred,
                durationMs,
                contentType: response.headers['content-type']
            });
        });

        // Pipe stream
        response.data.pipe(res);
    } catch (error) {
        logger.error('Error proxying media', {
            error: error.message,
            hostname: parsedUrl?.hostname,
            url: parsedUrl?.toString()
        });
        res.status(error.response?.status || 500).json({
            error: 'Error fetching media from Twilio',
            details: error.message
        });
    }
}));

/**
 * GET /api/health
 * Health check público
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'whatsapp-ai-assistant-api',
        version: '1.0.0'
    });
});

/**
 * GET /api/me
 * Obtiene información del usuario autenticado
 * Adaptado para el front (role UPPERCASE y campos específicos)
 */
router.get('/me', authMiddleware, catchAsync(async (req, res) => {
    logger.debug('User info requested via /api/me', { userId: req.userId });

    res.json({
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.full_name,
        role: (req.user.role || 'user').toUpperCase(), // El front espera ADMIN
        store_id: req.user.store_id,
        avatar_url: req.user.avatar_url,
        // Mantener compatibilidad si busca otros campos
        customer_name: req.user.full_name,
        ...req.user
    });
}));

/**
 * GET /api/products
 * Lista productos filtrados por tienda
 */
router.get('/products', authMiddleware, catchAsync(async (req, res) => {
    const { category, search, limit = 50 } = req.query;

    let query = supabaseAdmin
        .from('products')
        .select('*')
        .eq('is_active', true)
        .limit(parseInt(limit));

    if (req.user.store_id) {
        query = query.eq('store_id', req.user.store_id);
    }

    if (category) query = query.eq('category', category);
    if (search) {
        query = query.textSearch('search_vector', search, {
            type: 'websearch',
            config: 'spanish'
        });
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data); // Array directo como espera el frontend
}));

/**
 * GET /api/products/:id
 * Obtiene un producto específico (filtrado por tienda si aplica)
 */
router.get('/products/:id', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;

    let query = supabaseAdmin
        .from('products')
        .select('*')
        .eq('id', id);

    if (req.user.store_id) {
        query = query.eq('store_id', req.user.store_id);
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw error;

    if (!data) {
        return res.status(404).json({
            error: 'Not Found',
            message: 'Producto no encontrado'
        });
    }

    res.json({ product: data });
}));

/**
 * GET /api/conversations
 * Lista de chats adaptada perfectamente para el frontend
 */
router.get('/chats', authMiddleware, catchAsync(async (req, res) => {
    const { limit = 50, status = 'active' } = req.query;

    const requestedLimit = parseInt(limit);
    const requestedStatus = status;

    // Intento 1: nested select (requiere FK/relación en PostgREST)
    const runNestedSelect = async () => {
        let query = supabaseAdmin
            .from('chats')
            .select(`
                id,
                user_id,
                status,
                is_ai_paused,
                created_at,
                updated_at,
                last_message_at,
                last_message_preview,
                metadata,
                users (
                    phone_number,
                    display_name
                )
            `)
            .eq('status', requestedStatus);

        if (req.user.store_id) {
            query = query.eq('store_id', req.user.store_id);
        }

        return await query
            .order('last_message_at', { ascending: false })
            .limit(requestedLimit);
    };

    // Intento 2: fallback sin relación (traer users aparte)
    const runFallbackSelect = async () => {
        let query = supabaseAdmin
            .from('chats')
            .select('id,user_id,status,is_ai_paused,created_at,updated_at,last_message_at,last_message_preview,metadata')
            .eq('status', requestedStatus);

        if (req.user.store_id) {
            query = query.eq('store_id', req.user.store_id);
        }

        const { data: chats, error } = await query
            .order('last_message_at', { ascending: false })
            .limit(requestedLimit);

        if (error) return { data: null, error };

        const userIds = Array.from(new Set((chats || []).map(c => c.user_id).filter(Boolean)));

        let usersById = {};
        if (userIds.length > 0) {
            const { data: users, error: usersError } = await supabaseAdmin
                .from('users')
                .select('id,phone_number,display_name')
                .in('id', userIds);

            if (usersError) {
                logger.warn('Failed to load users for chats fallback', { error: usersError.message });
            } else {
                usersById = Object.fromEntries((users || []).map(u => [u.id, u]));
            }
        }

        const merged = (chats || []).map(chat => ({
            ...chat,
            users: usersById[chat.user_id] || null
        }));

        return { data: merged, error: null };
    };

    const { data: nestedChats, error: nestedError } = await runNestedSelect();

    let chats = nestedChats;
    if (nestedError) {
        const msg = String(nestedError.message || '');
        logger.warn('Nested select failed for chats, trying fallback', { error: msg });

        const { data: fallbackChats, error: fallbackError } = await runFallbackSelect();
        if (fallbackError) throw fallbackError;
        chats = fallbackChats;
    }

    // Calcular unread_count para cada chat de manera resiliente
    const chatIds = chats.map(c => c.id);
    let unreadCounts = {};

    if (chatIds.length > 0) {
        try {
            // Traemos solo los chat_id de mensajes no leídos enviados por el usuario
            const { data: unreadMessages, error: unreadError } = await supabaseAdmin
                .from('messages')
                .select('chat_id')
                .in('chat_id', chatIds)
                .eq('role', 'user')
                .neq('status', 'read'); // Asegurarse que el status sea distinto a read

            if (!unreadError && unreadMessages) {
                // Contar mensajes por chat_id
                unreadMessages.forEach(msg => {
                    unreadCounts[msg.chat_id] = (unreadCounts[msg.chat_id] || 0) + 1;
                });
            } else if (unreadError) {
                logger.error('Error fetching unread counts', unreadError);
                // No lanzamos error para permitir que la lista cargue aunque sea sin contadores
            }
        } catch (countError) {
            logger.error('Unexpected error calculating unread counts', countError);
        }
    }

    const adaptedChats = chats.map(chat => ({
        id: chat.id,
        chatId: chat.id,
        phone: chat.users?.phone_number,
        customer_phone: chat.users?.phone_number,
        customer_name: chat.users?.display_name || chat.users?.phone_number || 'Cliente WhatsApp',
        displayName: chat.users?.display_name || chat.users?.phone_number,
        status: chat.status,
        is_ai_paused: chat.is_ai_paused || false, // Nuevo campo para frontend
        last_message_at: chat.last_message_at,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        unread_count: unreadCounts[chat.id] || 0,
        metadata: chat.metadata || {},
        has_new_sale: chat.metadata?.has_new_sale || false,
        current_tag: chat.metadata?.current_tag || 'normal',
        // Objeto requerido para el sort y visualización en el front
        last_message: {
            content: chat.last_message_preview || '',
            created_at: chat.last_message_at || chat.updated_at
        }
    }));

    res.json(adaptedChats); // Array directo
}));

/**
 * PATCH /api/conversations/:id/read
 * Marca todos los mensajes de un chat como leídos
 */
router.patch('/chats/:id/read', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;

    // Actualizar mensajes no leídos del usuario a 'read'
    const { error } = await supabaseAdmin
        .from('messages')
        .update({ status: 'read' })
        .eq('chat_id', id)
        .eq('role', 'user')
        .neq('status', 'read');

    if (error) {
        logger.error('Error marking conversation as read', { chatId: id, error });
        throw error;
    }

    res.json({ success: true, message: 'Conversation marked as read' });
}));

/**
 * GET /api/conversations/:id/messages
 * Historial de mensajes con mapeo de campos
 */
router.get('/chats/:id/messages', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;
    const { limit = 50, cursor, before } = req.query;

    // Evitar caché en navegadores/proxies para asegurar datos frescos al cambiar de chat
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    // Permitir "cursor" o "before" como nombre del parámetro
    const beforeCursor = cursor || before;

    logger.debug(`[API] Fetching messages for chat ${id}`, { limit, beforeCursor });

    const messages = await getChatHistory(id, parseInt(limit), beforeCursor);

    if (messages && messages.length > 0) {
        logger.debug(`[API] Returning ${messages.length} messages. Last message ID: ${messages[0].id}, Content: ${messages[0].content?.substring(0, 20)}...`);
    } else {
        logger.debug(`[API] Returning 0 messages`);
    }

    res.json(messages); // El servicio ya devuelve el array mapeado
}));

/**
 * PATCH /api/conversations/:id
 * Actualizar estado del chat (incluyendo is_ai_paused)
 */
router.patch('/chats/:id', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;

    // DEBUG: Logs intensivos para diagnosticar problema de actualización
    console.log(`[DEBUG PATCH] Iniciando update para chat ${id}`);
    console.log(`[DEBUG PATCH] Body recibido:`, JSON.stringify(req.body));

    const { is_ai_paused, status } = req.body;
    console.log(`[DEBUG PATCH] Valor is_ai_paused: ${is_ai_paused} (tipo: ${typeof is_ai_paused})`);

    const updates = {};
    if (typeof is_ai_paused === 'boolean') updates.is_ai_paused = is_ai_paused;
    if (status) updates.status = status;

    console.log(`[DEBUG PATCH] Updates a aplicar:`, JSON.stringify(updates));

    if (Object.keys(updates).length === 0) {
        console.warn(`[DEBUG PATCH] No hay updates validos!`);
        return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabaseAdmin
        .from('chats')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        console.error(`[DEBUG PATCH] Error de Supabase:`, error);
        throw error;
    }

    console.log(`[DEBUG PATCH] Update exitoso. Nueva data:`, JSON.stringify(data));

    logger.info(`Chat updated`, { chatId: id, updates });
    res.json(data);
}));

/**
 * POST /api/conversations/:id/messages
 * Envío manual de mensaje (Human Handoff) a través de Twilio
 */
router.post('/chats/:id/messages', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;
    const { content, media_urls } = req.body; // Soporte opcional para adjuntos

    if (!content && (!media_urls || media_urls.length === 0)) {
        return res.status(400).json({ error: 'Content or media_urls is required' });
    }

    // 1. Obtener informaciòn del chat y usuario para saber el teléfono destino
    const { data: chat, error: chatError } = await supabaseAdmin
        .from('chats')
        .select('user_id, users(phone_number)')
        .eq('id', id)
        .single();

    if (chatError || !chat || !chat.users?.phone_number) {
        return res.status(404).json({ error: 'Chat or user phone not found' });
    }

    const userPhone = chat.users.phone_number;

    // 2. Enviar mensaje via Twilio
    // Nota: sendWhatsAppMessage en services/twilio.js actualmente solo soporta (to, message).
    // Si queremos media, el usuario debe haber solicitado expandir ese servicio o pasamos texto.
    // Dado que el usuario pidió "textarea", priorizamos texto.
    // Si se enviaron adjuntos, mandamos el texto primero y luego (o junto) los adjuntos si la función lo permite.
    // Revisando twilio.js del workspace, sendWhatsAppMessage solo toma (to, message).
    // Haremos el envío de texto. 
    // TODO: Expandir sendWhatsAppMessage para soportar mediaUrl si se requiere.

    let twilioSid;
    try {
        const response = await sendWhatsAppMessage(userPhone, content || '');
        twilioSid = response.sid;
    } catch (twilioError) {
        logger.error('Error sending manual WhatsApp message', twilioError);
        return res.status(500).json({ error: 'Failed to send message via Twilio' });
    }

    // 3. Guardar en base de datos como "assistant" (pero marcado como manual)
    try {
        const messageData = await saveMessage(
            id,
            chat.user_id,
            'assistant',
            content || '',
            {
                manual: true,
                is_human: true,
                media_urls: media_urls || []
            },
            twilioSid
        );

        res.status(201).json(messageData);
    } catch (dbError) {
        logger.error('Error saving manual message to DB', dbError);
        // Aunque falló la BD, el mensaje se envió. Devolvemos 200/201 con warning? 
        // Mejor 500 para alertar inconsistencia.
        return res.status(500).json({ error: 'Message sent but failed to save in DB' });
    }
}));

/**
 * POST /api/conversations/:id/attachments
 * Endpoint para recibir un fichero desde el panel administrativo, subirlo a Firebase, y enviarlo por Twilio
 */
router.post('/chats/:id/attachments', authMiddleware, uploadMiddleware.single('file'), catchAsync(async (req, res) => {
    const { id } = req.params;
    const file = req.file;
    const { message } = req.body;

    if (!file) {
        return res.status(400).json({ error: 'File is required' });
    }

    // 1. Obtener informaciòn del chat y usuario destino
    const { data: chat, error: chatError } = await supabaseAdmin
        .from('chats')
        .select('user_id, users(phone_number)')
        .eq('id', id)
        .single();

    if (chatError || !chat || !chat.users?.phone_number) {
        return res.status(404).json({ error: 'Chat or user phone not found' });
    }

    const userPhone = chat.users.phone_number;
    let publicFirebaseUrl;
    let storagePath;

    // 2. Subir directamente a Firebase desde Buffer local
    try {
        const timestamp = Date.now();
        const extension = file.originalname.split('.').pop();
        storagePath = `chat-media/admin/${id}/${timestamp}_${Date.now()}.${extension}`;

        logger.info(`Uploading admin attachment to Firebase`, { storagePath, mimetype: file.mimetype });

        // Se sube pasando explícitamente el buffer
        publicFirebaseUrl = await uploadFile(file.buffer, storagePath, file.mimetype);

        // Generar signed URL por varios días para que Twilio lea el archivo y el Frontend lo reproduzca si Firebase es privado
        const signedUrlResult = await getFirebaseSignedUrl(storagePath, 7); // Mantenemos link para Twilio 7 días
        publicFirebaseUrl = signedUrlResult.signedUrl;

    } catch (uploadError) {
        logger.error('Failed to upload attachment to Firebase', uploadError);
        return res.status(500).json({ error: 'Failed to process media upload' });
    }

    // 3. Enviar mensaje de Twilio incluyendo la mediaUrl
    let twilioSid;
    try {
        const textContent = message || '';
        const response = await sendWhatsAppMessage(userPhone, textContent, publicFirebaseUrl);
        twilioSid = response.sid;
    } catch (twilioError) {
        logger.error('Error sending media via Twilio', twilioError);
        return res.status(500).json({ error: 'Media uploaded but Twilio delivery failed' });
    }

    // 4. Registrar en Base de Datos como si fuese el Assistant "manual" (Human Handoff)
    try {
        const messageData = await saveMessage(
            id,
            chat.user_id,
            'assistant',
            message || '', // Puede ir vacío si es sólo foto
            {
                manual: true,
                is_human: true,
                attachments: [{
                    url: publicFirebaseUrl,
                    storage_path: storagePath,
                    storage_provider: 'firebase',
                    content_type: file.mimetype || 'application/octet-stream',
                    type: file.mimetype.startsWith('image/') ? 'image' :
                        file.mimetype.startsWith('video/') ? 'video' :
                            file.mimetype.startsWith('audio/') ? 'audio' : 'document'
                }]
            },
            twilioSid
        );

        res.status(201).json(messageData);
    } catch (dbError) {
        logger.error('Error saving manual media message to DB', dbError);
        return res.status(500).json({ error: 'Message sent but failed to save in DB' });
    }
}));

/**
 * GET /api/admin/users
 * Lista de usuarios filtrada por tienda
 */
router.get('/admin/users', authMiddleware, requireRole('admin'), catchAsync(async (req, res) => {
    const { limit = 50 } = req.query;

    let query = supabaseAdmin
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit));

    if (req.user.store_id) {
        query = query.eq('store_id', req.user.store_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
}));

/**
 * GET /api/sales/:id
 * Endpoint detallado para ver una orden específica
 */
router.get('/sales/:id', authMiddleware, catchAsync(async (req, res) => {
    const { id } = req.params;
    const storeId = req.user.store_id;

    // Buscar por ID (UUID) o por order_code (si es corto)
    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

    // Consulta para obtener detalles de la venta, items y usuario
    let query = supabaseAdmin
        .from('ai_sales')
        .select(`
            *,
            ai_sale_items (
                quantity,
                unit_price,
                subtotal,
                products (name, id)
            ),
            users (
                display_name,
                phone_number
            )
        `);

    if (isUUID) {
        query = query.eq('id', id);
    } else {
        query = query.eq('order_code', id);
    }

    // Filtro de seguridad por tienda
    if (storeId) {
        query = query.eq('store_id', storeId);
    }

    const { data: sale, error } = await query.single();

    if (error || !sale) {
        // Ignorar error de "no rows" (PGRST116) y devolver 404 limpio
        if (error && error.code !== 'PGRST116') logger.error('Error fetching sale details', error);
        return res.status(404).json({ error: 'Order not found' });
    }

    // Formatear respuesta para el frontend
    const formatted = {
        id: sale.id,
        order_code: sale.order_code || sale.id.slice(0, 8),
        created_at: sale.created_at,
        status: 'completed', // Por defecto, ya que ai_sales son completadas
        total_amount: sale.total_amount,
        payment_method: sale.payment_method,
        customer_name: sale.users?.display_name || 'Cliente WhatsApp',
        customer_phone: sale.users?.phone_number || 'N/A',
        items: (sale.ai_sale_items || []).map(item => ({
            id: item.products?.id, // ID del producto para linkear
            product_name: item.products?.name || 'Producto eliminado',
            quantity: item.quantity,
            unit_price: item.unit_price,
            subtotal: item.subtotal
        }))
    };

    res.json(formatted);
}));

/**
 * GET /api/sales
 * Historial de ventas
 */
router.get('/sales', authMiddleware, catchAsync(async (req, res) => {
    const { page = 1 } = req.query;
    const storeId = req.user.store_id;

    if (!storeId) {
        return res.json({
            data: [],
            pagination: { page: Number(page), pageSize: 10, total: 0 }
        });
    }

    const result = await salesService.getSales({
        storeId,
        page: Number(page),
        pageSize: 10
    });

    res.json(result);
}));

export default router;
