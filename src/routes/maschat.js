import express from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../services/supabase.js';
import { uploadFile as uploadFirebaseFile, getSignedUrl as getFirebaseSignedUrl } from '../services/firebase.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { logger } from '../middleware/logger.js';
import { catchAsync } from '../utils/errors.js';

const router = express.Router();
const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.use(authMiddleware);

/**
 * GET /api/maschat/conversations
 * Obtiene todas las conversaciones (canales y directos) del usuario en sesión
 */
router.get('/conversations', catchAsync(async (req, res) => {
    const userId = req.user.id;

    // 1. Obtener membresías del usuario
    const { data: myMemberships, error: memErr } = await supabaseAdmin
        .from('maschat_members')
        .select('channel_id, last_read_at, joined_at')
        .eq('user_id', userId);

    if (memErr) {
        logger.warn('Maschat: Warning querying memberships', { error: memErr.message });
        return res.json([]);
    }

    if (!myMemberships || myMemberships.length === 0) {
        return res.json([]);
    }

    const channelIds = myMemberships.map(m => m.channel_id);
    const readMap = myMemberships.reduce((acc, m) => {
        acc[m.channel_id] = m.last_read_at || m.joined_at;
        return acc;
    }, {});

    // 2. Obtener canales
    const { data: channels, error: chErr } = await supabaseAdmin
        .from('maschat_channels')
        .select('*')
        .in('id', channelIds)
        .order('updated_at', { ascending: false });

    if (chErr || !channels) {
        logger.warn('Maschat: Warning querying channels', { error: chErr?.message });
        return res.json([]);
    }

    // 3. Obtener todos los miembros de estos canales
    const { data: allMembers } = await supabaseAdmin
        .from('maschat_members')
        .select('channel_id, user_id')
        .in('channel_id', channelIds);

    const userIds = [...new Set((allMembers || []).map(m => m.user_id))];

    let profilesMap = {};
    if (userIds.length > 0) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, email, avatar_url, role')
            .in('id', userIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {});
        }
    }

    // 4. Obtener último mensaje de cada canal y conteo de no leídos
    const enrichedConversations = await Promise.all(channels.map(async (ch) => {
        // Último mensaje
        const { data: lastMsgs } = await supabaseAdmin
            .from('maschat_messages')
            .select('*')
            .eq('channel_id', ch.id)
            .order('created_at', { ascending: false })
            .limit(1);

        const lastMessage = lastMsgs && lastMsgs.length > 0 ? lastMsgs[0] : null;

        // Conteo de mensajes no leídos
        const lastRead = readMap[ch.id];
        let unreadCount = 0;
        if (lastRead) {
            const { count } = await supabaseAdmin
                .from('maschat_messages')
                .select('id', { count: 'exact', head: true })
                .eq('channel_id', ch.id)
                .gt('created_at', lastRead)
                .neq('sender_id', userId);

            unreadCount = count || 0;
        }

        // Miembros del canal
        const chMembers = (allMembers || [])
            .filter(m => m.channel_id === ch.id)
            .map(m => profilesMap[m.user_id] || { id: m.user_id, full_name: 'Usuario' });

        // Si es DIRECT, obtener la información del otro usuario
        let otherUser = null;
        if (ch.type === 'DIRECT') {
            otherUser = chMembers.find(m => m.id !== userId) || chMembers[0] || null;
        }

        return {
            ...ch,
            members: chMembers,
            other_user: otherUser,
            last_message: lastMessage ? {
                ...lastMessage,
                sender: profilesMap[lastMessage.sender_id] || null
            } : null,
            unread_count: unreadCount
        };
    }));

    // Ordenar por updated_at descendente
    enrichedConversations.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    res.json(enrichedConversations);
}));

/**
 * POST /api/maschat/direct
 * Inicia o devuelve una conversación privada 1 a 1
 */
router.post('/direct', catchAsync(async (req, res) => {
    const userId = req.user.id;
    const { target_user_id } = req.body;

    if (!target_user_id) {
        return res.status(400).json({ error: 'target_user_id es obligatorio' });
    }

    if (target_user_id === userId) {
        return res.status(400).json({ error: 'No puedes abrir un chat directo contigo mismo' });
    }

    // Buscar si ya existe una conversación directa entre ambos
    const { data: myMemberships } = await supabaseAdmin
        .from('maschat_members')
        .select('channel_id')
        .eq('user_id', userId);

    const myChannelIds = (myMemberships || []).map(m => m.channel_id);

    if (myChannelIds.length > 0) {
        const { data: commonMembers } = await supabaseAdmin
            .from('maschat_members')
            .select('channel_id')
            .eq('user_id', target_user_id)
            .in('channel_id', myChannelIds);

        const commonChannelIds = (commonMembers || []).map(c => c.channel_id);

        if (commonChannelIds.length > 0) {
            const { data: directCh } = await supabaseAdmin
                .from('maschat_channels')
                .select('*')
                .eq('type', 'DIRECT')
                .in('id', commonChannelIds)
                .maybeSingle();

            if (directCh) {
                return res.json(directCh);
            }
        }
    }

    // Si no existe, crear canal DIRECT
    const now = new Date().toISOString();
    const { data: newChannel, error: createErr } = await supabaseAdmin
        .from('maschat_channels')
        .insert({
            type: 'DIRECT',
            created_by: userId,
            created_at: now,
            updated_at: now
        })
        .select()
        .single();

    if (createErr) {
        logger.error('Maschat: Error creating direct channel', createErr);
        throw createErr;
    }

    // Insertar a ambos como miembros
    await supabaseAdmin.from('maschat_members').insert([
        { channel_id: newChannel.id, user_id: userId, joined_at: now, last_read_at: now },
        { channel_id: newChannel.id, user_id: target_user_id, joined_at: now, last_read_at: now }
    ]);

    res.status(201).json(newChannel);
}));

/**
 * POST /api/maschat/channels
 * Crea un canal grupal con miembros asignados
 */
router.post('/channels', catchAsync(async (req, res) => {
    const userId = req.user.id;
    const { name, member_ids = [] } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'El nombre del canal es obligatorio' });
    }

    const now = new Date().toISOString();
    const { data: newChannel, error: chErr } = await supabaseAdmin
        .from('maschat_channels')
        .insert({
            name: name.trim(),
            type: 'CHANNEL',
            created_by: userId,
            created_at: now,
            updated_at: now
        })
        .select()
        .single();

    if (chErr) {
        logger.error('Maschat: Error creating channel', chErr);
        throw chErr;
    }

    // Unir a todos los miembros (incluyendo al creador)
    const allMemberIds = [...new Set([...member_ids, userId])];
    const memberRows = allMemberIds.map(uid => ({
        channel_id: newChannel.id,
        user_id: uid,
        joined_at: now,
        last_read_at: now
    }));

    await supabaseAdmin.from('maschat_members').insert(memberRows);

    res.status(201).json(newChannel);
}));

/**
 * GET /api/maschat/channels/:id/messages
 * Historial de mensajes de un chat o canal
 */
router.get('/channels/:id/messages', catchAsync(async (req, res) => {
    const channelId = req.params.id;
    const userId = req.user.id;

    if (!channelId || channelId === 'undefined' || channelId === 'null') {
        return res.status(400).json({ error: 'ID de conversación no válido' });
    }

    // Verificar que el usuario pertenezca al canal
    const { data: membership } = await supabaseAdmin
        .from('maschat_members')
        .select('id')
        .eq('channel_id', channelId)
        .eq('user_id', userId)
        .maybeSingle();

    if (!membership && req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'No tienes acceso a este canal' });
    }

    // Actualizar última lectura
    await supabaseAdmin
        .from('maschat_members')
        .update({ last_read_at: new Date().toISOString() })
        .eq('channel_id', channelId)
        .eq('user_id', userId);

    // Consultar mensajes
    const { data: messages, error } = await supabaseAdmin
        .from('maschat_messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(100);

    if (error) {
        logger.warn('Maschat: Warning fetching messages', error);
        return res.json([]);
    }

    if (!messages || messages.length === 0) {
        return res.json([]);
    }

    // Enriquecer con perfiles de remitentes
    const senderIds = [...new Set(messages.map(m => m.sender_id))];
    let profilesMap = {};
    if (senderIds.length > 0) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, email, avatar_url, role')
            .in('id', senderIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {});
        }
    }

    const enrichedMessages = messages.map(m => ({
        ...m,
        sender: profilesMap[m.sender_id] || { id: m.sender_id, full_name: 'Usuario' }
    }));

    res.json(enrichedMessages);
}));

/**
 * POST /api/maschat/channels/:id/messages
 * Envía un mensaje (texto o multimedia) al canal
 */
router.post('/channels/:id/messages', catchAsync(async (req, res) => {
    const channelId = req.params.id;
    const userId = req.user.id;
    const { content, media_url, media_type, media_name } = req.body;

    if (!channelId || channelId === 'undefined' || channelId === 'null') {
        return res.status(400).json({ error: 'ID de conversación no válido' });
    }

    if ((!content || content.trim().length === 0) && !media_url) {
        return res.status(400).json({ error: 'El mensaje debe contener texto o un archivo' });
    }

    const now = new Date().toISOString();
    const payload = {
        channel_id: channelId,
        sender_id: userId,
        content: content ? content.trim() : '',
        media_url: media_url || null,
        media_type: media_type || 'text',
        media_name: media_name || null,
        created_at: now
    };

    const { data: newMsg, error } = await supabaseAdmin
        .from('maschat_messages')
        .insert(payload)
        .select()
        .single();

    if (error) {
        logger.error('Maschat: Error sending message', error);
        throw error;
    }

    // Actualizar timestamp del canal y la marca de lectura del remitente
    await supabaseAdmin
        .from('maschat_channels')
        .update({ updated_at: now })
        .eq('id', channelId);

    await supabaseAdmin
        .from('maschat_members')
        .update({ last_read_at: now })
        .eq('channel_id', channelId)
        .eq('user_id', userId);

    // Obtener perfil del remitente para devolver el mensaje enriquecido
    const { data: senderProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email, avatar_url, role')
        .eq('id', userId)
        .maybeSingle();

    res.status(201).json({
        ...newMsg,
        sender: senderProfile || { id: userId, full_name: req.user.full_name || 'Tú' }
    });
}));

/**
 * POST /api/maschat/upload
 * Sube un archivo adjunto o nota de voz a Storage
 */
router.post('/upload', uploadMiddleware.single('file'), catchAsync(async (req, res) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'Archivo no recibido' });
    }

    const timestamp = Date.now();
    let originalName = file.originalname || 'file';
    try {
        // Corregir codificación si multer parseó como latin1
        originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (e) {
        originalName = file.originalname || 'file';
    }

    // Sanitizar nombre para Supabase Storage S3 key (solo caracteres ASCII seguros)
    const safeName = originalName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
        .replace(/[^a-zA-Z0-9._-]/g, '_') // Caracteres no alfanuméricos a _
        .replace(/_+/g, '_');             // Colapsar guiones bajos repetidos

    const storagePath = `maschat/${req.user.id}/${timestamp}_${safeName}`;

    let mediaUrl = null;

    // 1. Intentar subir a Supabase Storage (bucket chat-media)
    try {
        const { data: supaData, error: supaErr } = await supabaseAdmin.storage
            .from('chat-media')
            .upload(storagePath, file.buffer, {
                contentType: file.mimetype,
                upsert: true
            });

        if (!supaErr && supaData) {
            const { data: pubUrl } = supabaseAdmin.storage
                .from('chat-media')
                .getPublicUrl(storagePath);
            mediaUrl = pubUrl?.publicUrl;
        } else if (supaErr) {
            logger.warn('Maschat: Error en upload a chat-media de Supabase', supaErr);
        }
    } catch (e) {
        logger.warn('Maschat: Supabase storage upload exception, intentando fallback si existe', e);
    }

    // 2. Si no se obtuvo URL de Supabase, intentar Firebase Storage
    if (!mediaUrl) {
        try {
            await uploadFirebaseFile(file.buffer, storagePath, file.mimetype);
            const signedResult = await getFirebaseSignedUrl(storagePath, 30); // 30 días
            mediaUrl = signedResult.signedUrl;
        } catch (fbErr) {
            logger.error('Maschat: Failed to upload to storage', fbErr);
            return res.status(500).json({ error: 'No se pudo subir el archivo al almacenamiento en la nube' });
        }
    }

    // Determinar media_type
    let mediaType = 'document';
    if (file.mimetype.startsWith('image/')) mediaType = 'image';
    else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';
    else if (file.mimetype.startsWith('video/')) mediaType = 'video';

    res.json({
        media_url: mediaUrl,
        media_name: originalName,
        media_type: mediaType,
        mimetype: file.mimetype,
        size: file.size
    });
}));

/**
 * PUT /api/maschat/channels/:id/read
 * Marca una conversación como leída
 */
router.put('/channels/:id/read', catchAsync(async (req, res) => {
    const channelId = req.params.id;
    const userId = req.user.id;

    if (!channelId || channelId === 'undefined' || channelId === 'null') {
        return res.status(400).json({ error: 'ID de conversación no válido' });
    }

    const now = new Date().toISOString();

    await supabaseAdmin
        .from('maschat_members')
        .update({ last_read_at: now })
        .eq('channel_id', channelId)
        .eq('user_id', userId);

    res.json({ success: true });
}));

export default router;
