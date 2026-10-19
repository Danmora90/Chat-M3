import twilio from 'twilio';
import axios from 'axios';
import { supabaseAdmin } from './supabase.js';
import { logger } from '../middleware/logger.js';

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

/**
 * Helper para generar cabecera de autenticación HTTP Basic para Twilio REST API
 */
function getTwilioAuthHeader() {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    return {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
    };
}

/**
 * Servicio para interactuar con Twilio Content API y sincronizar plantillas con Supabase
 */
export const twilioContentService = {
    /**
     * Crea un recurso de contenido en Twilio y lo envía automáticamente a aprobación en WhatsApp.
     * @param {Object} params
     * @param {string} params.friendlyName - Nombre descriptivo de la plantilla
     * @param {string} params.category - 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
     * @param {string} params.language - Código ISO, ej: 'es' o 'es_LA'
     * @param {string} params.body - Texto del mensaje (soporta variables {{1}}, {{2}}, etc.)
     * @param {Array<string>} [params.variables] - Lista de variables detectadas, ej: ['1', '2']
     * @param {Object} [params.variableSamples] - Mapeo de valores de ejemplo reales, ej: { '1': 'Juan', '2': '15 de Noviembre' }
     */
    async createAndSubmitTemplate({ friendlyName, category = 'UTILITY', language = 'es', body, variables = [], variableSamples = {} }) {
        try {
            logger.info('TwilioContent: Creating Content resource via Twilio REST API', { friendlyName, category, language });

            const safeInternalName = friendlyName
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9_]/g, '_')
                .slice(0, 64);

            // Mapear cada variable con su valor de ejemplo real ingresado por el usuario o fallback
            const variablesMap = variables.reduce((acc, v) => {
                const sample = variableSamples && variableSamples[v] && String(variableSamples[v]).trim();
                return {
                    ...acc,
                    [v]: sample || `ejemplo_${v}`
                };
            }, {});

            // 1. Crear el Content en Twilio
            const contentPayload = {
                friendly_name: safeInternalName,
                language: language,
                variables: variablesMap,
                types: {
                    'twilio/text': {
                        body: body
                    }
                }
            };

            const headers = getTwilioAuthHeader();
            const createRes = await axios.post('https://content.twilio.com/v1/Content', contentPayload, { headers });
            const contentSid = createRes.data?.sid;

            if (!contentSid) {
                throw new Error('Twilio no retornó un ContentSid válido.');
            }

            logger.info('TwilioContent: Resource created successfully', { contentSid });

            // 2. Enviar a aprobación en WhatsApp (Meta)
            let approvalStatus = 'submitted';
            let rejectionReason = null;

            try {
                const approvalRes = await axios.post(
                    `https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests/whatsapp`,
                    {
                        name: safeInternalName,
                        category: category.toUpperCase()
                    },
                    { headers }
                );

                const approvalData = approvalRes.data;
                logger.info('TwilioContent: WhatsApp Approval request submitted', {
                    contentSid,
                    approvalStatus: approvalData?.status
                });

                if (approvalData?.status) {
                    approvalStatus = approvalData.status.toLowerCase();
                    rejectionReason = approvalData.rejection_reason || null;
                }
            } catch (approvalErr) {
                logger.warn('TwilioContent: WhatsApp approval request submission notice', {
                    contentSid,
                    error: approvalErr.response?.data?.message || approvalErr.message
                });
                approvalStatus = 'submitted';
            }

            // 3. Guardar o sincronizar en Supabase si la tabla existe
            let localRecord = null;
            try {
                const { data, error } = await supabaseAdmin
                    .from('whatsapp_templates')
                    .insert({
                        content_sid: contentSid,
                        friendly_name: friendlyName,
                        category: category.toUpperCase(),
                        language: language,
                        body: body,
                        variables: variables,
                        status: approvalStatus,
                        rejection_reason: rejectionReason,
                        updated_at: new Date().toISOString()
                    })
                    .select()
                    .single();

                if (!error) {
                    localRecord = data;
                }
            } catch (dbErr) {
                logger.warn('TwilioContent: DB insert exception', { error: dbErr.message });
            }

            return {
                success: true,
                contentSid,
                friendlyName,
                status: approvalStatus,
                rejectionReason,
                record: localRecord || {
                    content_sid: contentSid,
                    friendly_name: friendlyName,
                    category,
                    language,
                    body,
                    variables,
                    status: approvalStatus,
                    created_at: new Date().toISOString()
                }
            };
        } catch (error) {
            const twilioErrorMsg = error.response?.data?.message || error.message;
            logger.error('TwilioContent: Error creating template', {
                error: twilioErrorMsg,
                details: error.response?.data
            });
            throw new Error(twilioErrorMsg || 'Error al crear la plantilla en Twilio');
        }
    },

    /**
     * Obtiene el estado actual de aprobación en WhatsApp desde Twilio
     * @param {string} contentSid
     */
    async getTemplateStatus(contentSid) {
        try {
            logger.info('TwilioContent: Fetching approval status from Twilio', { contentSid });
            const approvalData = await client.content.v1.contents(contentSid).approvalFetch().fetch();

            let status = 'submitted';
            let rejectionReason = null;

            if (approvalData && approvalData.whatsapp) {
                status = approvalData.whatsapp.status ? approvalData.whatsapp.status.toLowerCase() : 'submitted';
                rejectionReason = approvalData.whatsapp.rejection_reason || null;
            }

            // Actualizar Supabase si está disponible
            try {
                await supabaseAdmin
                    .from('whatsapp_templates')
                    .update({
                        status,
                        rejection_reason: rejectionReason,
                        updated_at: new Date().toISOString()
                    })
                    .eq('content_sid', contentSid);
            } catch (err) {
                // Silencioso en caso de no existir tabla
            }

            return {
                contentSid,
                status,
                rejectionReason
            };
        } catch (error) {
            logger.error('TwilioContent: Error fetching status', { contentSid, error: error.message });
            throw error;
        }
    },

    /**
     * Lista todas las plantillas registradas trayendo el estado real de aprobación desde Twilio
     */
    async listTemplates() {
        try {
            logger.info('TwilioContent: Fetching contents and approvals from Twilio');
            const list = await client.content.v1.contentAndApprovals.list({ limit: 50 });

            return list.map(c => {
                const textBody = c.types?.['twilio/text']?.body || '';
                const wa = c.approvalRequests || {};
                const status = wa.status ? wa.status.toLowerCase() : 'submitted';
                return {
                    id: c.sid,
                    content_sid: c.sid,
                    friendly_name: c.friendlyName,
                    language: c.language,
                    category: wa.category || 'UTILITY',
                    body: textBody,
                    variables: Object.keys(c.variables || {}),
                    variable_samples: c.variables || {},
                    status: status,
                    rejection_reason: wa.rejection_reason || null,
                    created_at: c.dateCreated
                };
            });
        } catch (error) {
            logger.error('TwilioContent: Error listing templates', { error: error.message });
            throw error;
        }
    },

    /**
     * Elimina un recurso de plantilla en Twilio y en Supabase
     * @param {string} contentSid
     */
    async deleteTemplate(contentSid) {
        try {
            logger.info('TwilioContent: Deleting content resource', { contentSid });
            await client.content.v1.contents(contentSid).remove();

            try {
                await supabaseAdmin
                    .from('whatsapp_templates')
                    .delete()
                    .eq('content_sid', contentSid);
            } catch (dbErr) {
                logger.warn('TwilioContent: Warning deleting from DB', { error: dbErr.message });
            }

            return { success: true, contentSid };
        } catch (error) {
            logger.error('TwilioContent: Error deleting template', { contentSid, error: error.message });
            throw error;
        }
    },

    /**
     * Obtiene el texto renderizado de una plantilla, buscando en DB o consultando a Twilio directamente y cacheando en DB.
     * @param {string} contentSid
     * @param {Object} [variables]
     * @returns {Promise<string>}
     */
    async getRenderedTemplateBody(contentSid, variables = {}) {
        if (!contentSid) return '';
        let body = '';

        try {
            // 1. Intentar buscar en tabla whatsapp_templates
            const { data: dbTmpl } = await supabaseAdmin
                .from('whatsapp_templates')
                .select('body, friendly_name')
                .eq('content_sid', contentSid)
                .maybeSingle();

            if (dbTmpl?.body) {
                body = dbTmpl.body;
            } else {
                // 2. Si no está en DB, consultar directamente a Twilio
                const content = await client.content.v1.contents(contentSid).fetch();
                body = content.types?.['twilio/text']?.body ||
                       content.types?.['twilio/quick-reply']?.body ||
                       content.types?.['twilio/call-to-action']?.body ||
                       content.types?.['twilio/card']?.body || '';

                // Cachear en whatsapp_templates para acelerar futuras consultas
                if (body) {
                    try {
                        await supabaseAdmin
                            .from('whatsapp_templates')
                            .upsert({
                                content_sid: contentSid,
                                friendly_name: content.friendlyName || contentSid,
                                body: body,
                                language: content.language || 'es',
                                status: 'approved',
                                updated_at: new Date().toISOString()
                            }, { onConflict: 'content_sid' });
                    } catch (cacheErr) {
                        // Silencioso
                    }
                }
            }

            // 3. Reemplazar variables dinámicas {{1}}, {{2}}, etc.
            if (body && variables && typeof variables === 'object') {
                for (const [key, val] of Object.entries(variables)) {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    body = body.replace(regex, val != null ? String(val) : '');
                }
            }
        } catch (err) {
            logger.warn('TwilioContent: Error fetching template body', { contentSid, error: err.message });
        }

        return body || `[Plantilla enviada: ${contentSid}]`;
    }
};
