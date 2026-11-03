import OpenAI from 'openai';
import { supabaseAdmin } from './supabase.js';
import { twilioContentService } from './twilioContentService.js';
import { getPromptDetails, saveSystemPrompt } from './promptService.js';
import { analyzePromptToolGaps } from './promptGapService.js';
import { logger } from '../middleware/logger.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Catálogo oficial de las 12 etapas del CRM comercial en MAS.3
export const OFFICIAL_STAGES = [
    '1 - No tiene presupuesto',
    '2 - Credito negado',
    '3 - Le entregan lejos',
    '4 - Escribió',
    '5 - Pidio info',
    '6 - Lead',
    '7 - No asistio',
    '8 - Agendado',
    '9 - Cotizado',
    '10 - Cliente',
    '11 - Perdido',
    '12 - No agendo'
];

// Píldoras dinámicas soportadas en las automatizaciones
export const DYNAMIC_PILLS = [
    { tag: '{{nombre}}', desc: 'Nombre real del cliente o "Cliente"' },
    { tag: '{{telefono}}', desc: 'Número celular de WhatsApp' },
    { tag: '{{fecha_actual}}', desc: 'Fecha actual en Colombia (GMT-5)' },
    { tag: '{{link_agendamiento}}', desc: 'Link de reunión o agendamiento' },
    { tag: '{{fecha_cita}}', desc: 'Fecha de la cita registrada en CRM' },
    { tag: '{{cotizacion}}', desc: 'Rango estimado de cotización' },
    { tag: '{{valor_remodelacion}}', desc: 'Valor cotizado de remodelación' }
];

const COPILOT_SYSTEM_PROMPT = `Eres el "Copilot Administrativo de MAS.3", un asistente de inteligencia artificial exclusivo para los directores y administradores de MAS.3 (remodelaciones arquitectónicas y construcción en Colombia).

Tu función principal es ejecutar tareas operativas que el administrador te ordene por lenguaje natural, asesorarlo y asegurar que todo se configure bajo las reglas técnicas y de negocio de la plataforma:

=======================================================
REGLAS Y CONOCIMIENTO SUPREMO DE MAS.3:
=======================================================
1. PLANTILLAS DE WHATSAPP (Twilio Content API / Meta):
   - Cada plantilla debe tener un 'friendlyName' claro (ej: seguimiento_cotizados_marzo).
   - Categorías permitidas: 'UTILITY' (seguimientos, citas, cotizaciones, información de servicios) o 'MARKETING' (promociones, invitaciones, ofertas).
   - Idioma por defecto: 'es'.
   - El cuerpo del mensaje usa variables tipo {{1}}, {{2}}, etc.
   - REGLA CRÍTICA DE META: Meta exige OBLIGATORIAMENTE un ejemplo real para cada variable antes de aprobarla. Si el admin no te proporciona los ejemplos, debes preguntárselos o proponerle ejemplos coherentes (ej: {{1}} -> 'Daniel', {{2}} -> '$45.000.000 COP').
   - Una plantilla no puede enviarse vacía ni con variables sin ejemplo.

2. FLUJOS DE AUTOMATIZACIÓN COMERCIAL:
   - Disparador 'stage_change': Se activa cuando un cliente cambia a una etapa específica del embudo. Las 12 etapas oficiales son:
     ${OFFICIAL_STAGES.map(s => `* "${s}"`).join('\n     ')}
   - Disparador 'inactivity': Se activa tras cierto tiempo de inactividad del cliente (ej: 30 minutos, 2 horas, 1 día). Por seguridad del sistema, nunca se dispara a conversaciones que hayan terminado antes de crear el flujo.
   - Pasos del flujo ('steps'):
     * 'send_template': Envía una plantilla aprobada de WhatsApp. Soporta condiciones ('if_no_reply' o 'always'), delay (delay_value y delay_unit: 'minutes'|'hours'|'days'), y mapeo de variables dinámicas (${DYNAMIC_PILLS.map(p => p.tag).join(', ')}) o texto estático.
     * 'notify_admin': Envía una notificación por WhatsApp al equipo administrativo con datos del lead.
   - Protección: El sistema cancela pasos pendientes automáticamente si el cliente contesta antes de la ejecución.

3. PROMPTS DEL AGENTE COMERCIAL (Felipe):
   - El agente comercial de atención al cliente en WhatsApp se rige por el System Prompt guardado en la base de datos.
   - Puedes consultar el prompt activo o actualizarlo. Al actualizarlo, la plataforma valida automáticamente si el nuevo texto solicita tareas que carezcan de herramientas.

4. CRM Y PROSPECTOS:
   - Puedes consultar el resumen de clientes por etapa, ver prospectos individuales y cambiar la etapa de un cliente.
   - También puedes consultar o crear tareas para el equipo administrativo.

=======================================================
PROTOCOLO DE INTERACCIÓN CON EL ADMINISTRADOR:
=======================================================
- Eres altamente profesional, conciso, ejecutivo y proactivo.
- Si el administrador te pide algo incompleto (ej: "crea un template para agendar"), REDACTA una propuesta completa de texto, identifica las variables requeridas, propón los ejemplos reales y PREGÚNTALE si está de acuerdo o si desea cambiar algo antes de enviarlo a aprobación.
- Cuando una acción tenga impacto directo (crear plantilla, crear flujo, cambiar prompt), presenta un resumen claro y pide confirmación antes de llamar a la herramienta definitiva, a menos que el admin ya haya dado una orden categórica e inequívoca como "créalo inmediatamente con estos datos exactos".
- Al completar una acción, reporta el resultado de forma clara con los identificadores generados (SIDs, nombres o IDs de base de datos).
`;

// Declaración de herramientas (Function Calling)
const COPILOT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'crear_template_whatsapp',
            description: 'Crea una nueva plantilla de WhatsApp en Twilio y la envía a aprobación a Meta.',
            parameters: {
                type: 'object',
                properties: {
                    friendlyName: {
                        type: 'string',
                        description: 'Nombre descriptivo de la plantilla (ej: seguimiento_cotizacion_v1)'
                    },
                    category: {
                        type: 'string',
                        enum: ['UTILITY', 'MARKETING'],
                        description: 'Categoría de la plantilla'
                    },
                    language: {
                        type: 'string',
                        description: 'Código de idioma (default: es)'
                    },
                    body: {
                        type: 'string',
                        description: 'Cuerpo del mensaje en texto plano con variables {{1}}, {{2}}, etc.'
                    },
                    variableSamples: {
                        type: 'object',
                        description: 'Mapeo de valores de ejemplo reales para cada variable detectada (ej: {"1": "Daniel", "2": "$50.000.000"})'
                    }
                },
                required: ['friendlyName', 'category', 'body', 'variableSamples']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consultar_templates_whatsapp',
            description: 'Lista todas las plantillas registradas en Twilio con su estado de aprobación en WhatsApp.',
            parameters: {
                type: 'object',
                properties: {
                    statusFilter: {
                        type: 'string',
                        enum: ['all', 'approved', 'pending', 'rejected'],
                        description: 'Filtrar por estado de aprobación (opcional)'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'crear_flujo_automatizacion',
            description: 'Crea un nuevo flujo de automatización comercial (por cambio de etapa o por inactividad) con uno o varios pasos.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Nombre descriptivo del flujo'
                    },
                    description: {
                        type: 'string',
                        description: 'Propósito o descripción del flujo'
                    },
                    trigger_type: {
                        type: 'string',
                        enum: ['stage_change', 'inactivity'],
                        description: 'Tipo de disparador'
                    },
                    trigger_stage: {
                        type: 'string',
                        description: 'Etapa del embudo requerida si trigger_type es stage_change (ej: "8 - Agendado", "9 - Cotizado")'
                    },
                    inactivity_minutes: {
                        type: 'number',
                        description: 'Minutos de inactividad requeridos si trigger_type es inactivity'
                    },
                    steps: {
                        type: 'array',
                        description: 'Lista ordenada de pasos a ejecutar',
                        items: {
                            type: 'object',
                            properties: {
                                delay_value: { type: 'number', description: 'Cantidad de tiempo de espera' },
                                delay_unit: { type: 'string', enum: ['minutes', 'hours', 'days'] },
                                condition: { type: 'string', enum: ['if_no_reply', 'always'] },
                                action_type: { type: 'string', enum: ['send_template', 'notify_admin'] },
                                template_sid: { type: 'string', description: 'Content SID de la plantilla si action_type es send_template' },
                                variables: { type: 'object', description: 'Mapeo de variables dinámicas o estáticas' },
                                target_phones: { type: 'array', items: { type: 'string' }, description: 'Teléfonos si action_type es notify_admin' },
                                message: { type: 'string', description: 'Texto del mensaje si action_type es notify_admin' }
                            },
                            required: ['delay_value', 'delay_unit', 'condition', 'action_type']
                        }
                    },
                    is_active: {
                        type: 'boolean',
                        description: 'Si el flujo debe crearse activo de inmediato (default: true)'
                    }
                },
                required: ['name', 'trigger_type', 'steps']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consultar_flujos_automatizacion',
            description: 'Lista los flujos de automatización existentes con sus pasos y estadísticas de tareas.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'alternar_estado_flujo',
            description: 'Activa o pausa un flujo de automatización existente.',
            parameters: {
                type: 'object',
                properties: {
                    flowId: { type: 'string', description: 'ID del flujo' },
                    is_active: { type: 'boolean', description: 'true para activar, false para pausar' }
                },
                required: ['flowId', 'is_active']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consultar_prompt_comercial',
            description: 'Consulta el System Prompt activo del agente comercial de ventas (Felipe) y su historial.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'actualizar_prompt_comercial',
            description: 'Actualiza el System Prompt del agente de ventas con nuevo contenido tras confirmación.',
            parameters: {
                type: 'object',
                properties: {
                    nuevo_prompt: { type: 'string', description: 'El texto íntegro del nuevo System Prompt' },
                    motivo: { type: 'string', description: 'Razón del cambio o notas de versión' }
                },
                required: ['nuevo_prompt']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consultar_resumen_crm',
            description: 'Obtiene las métricas actuales del CRM: cantidad de prospectos en cada una de las 12 etapas del embudo.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consultar_prospectos_etapa',
            description: 'Lista prospectos detallados en una etapa específica del embudo.',
            parameters: {
                type: 'object',
                properties: {
                    etapa: { type: 'string', description: 'Etapa del embudo (ej: "8 - Agendado", "9 - Cotizado")' },
                    limite: { type: 'number', description: 'Límite de registros a retornar (default: 10)' }
                },
                required: ['etapa']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cambiar_etapa_prospecto',
            description: 'Mueve a un cliente/prospecto a una nueva etapa del embudo comercial en el CRM.',
            parameters: {
                type: 'object',
                properties: {
                    chatIdOrPhone: { type: 'string', description: 'ID del chat o número de teléfono del cliente' },
                    nuevaEtapa: { type: 'string', description: 'Una de las 12 etapas oficiales' }
                },
                required: ['chatIdOrPhone', 'nuevaEtapa']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'crear_tarea_equipo',
            description: 'Crea una tarea interna para el equipo o asignada a un colaborador en el módulo de Tareas.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Título de la tarea' },
                    description: { type: 'string', description: 'Descripción o detalles de la tarea' },
                    priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
                    due_date: { type: 'string', description: 'Fecha límite ISO (YYYY-MM-DD)' }
                },
                required: ['title']
            }
        }
    }
];

// Almacén en memoria de sesiones conversacionales por usuario/admin
const sessionsStore = new Map();

/**
 * Obtiene o inicializa el historial de mensajes de la sesión del administrador
 */
function getSessionHistory(sessionId) {
    if (!sessionsStore.has(sessionId)) {
        sessionsStore.set(sessionId, [
            { role: 'system', content: COPILOT_SYSTEM_PROMPT }
        ]);
    }
    return sessionsStore.get(sessionId);
}

/**
 * Ejecutor local de herramientas de administración
 */
async function executeAdminTool(toolName, args, adminContext = {}) {
    logger.info(`AdminCopilot: Executing tool "${toolName}"`, { args, adminContext });

    try {
        switch (toolName) {
            case 'crear_template_whatsapp': {
                const { friendlyName, category, language, body, variableSamples } = args;
                const matches = body.match(/\{\{([0-9a-zA-Z_]+)\}\}/g) || [];
                const detectedVars = [...new Set(matches.map(m => m.replace(/[\{\}]/g, '')))];

                const result = await twilioContentService.createAndSubmitTemplate({
                    friendlyName,
                    category: category || 'UTILITY',
                    language: language || 'es',
                    body,
                    variables: detectedVars,
                    variableSamples: variableSamples || {}
                });

                return {
                    success: true,
                    message: `Plantilla creada con éxito y enviada a revisión a Meta/WhatsApp`,
                    content_sid: result.content_sid,
                    friendly_name: result.friendly_name,
                    approval_status: result.approval_status
                };
            }

            case 'consultar_templates_whatsapp': {
                const templates = await twilioContentService.listTemplates();
                const filtered = args.statusFilter && args.statusFilter !== 'all'
                    ? templates.filter(t => (t.approval_status || '').toLowerCase() === args.statusFilter.toLowerCase())
                    : templates;

                return {
                    success: true,
                    count: filtered.length,
                    templates: filtered.map(t => ({
                        friendly_name: t.friendly_name,
                        content_sid: t.content_sid,
                        category: t.category,
                        status: t.approval_status,
                        variables: t.variables || [],
                        samples: t.variable_samples || {}
                    }))
                };
            }

            case 'crear_flujo_automatizacion': {
                const { name, description, trigger_type, trigger_stage, inactivity_minutes, steps, is_active } = args;

                const storeId = process.env.STORE_ID || null;
                const { data: newFlow, error } = await supabaseAdmin
                    .from('automation_flows')
                    .insert({
                        name,
                        description: description || null,
                        trigger_type,
                        trigger_stage: trigger_type === 'stage_change' ? trigger_stage : null,
                        inactivity_minutes: trigger_type === 'inactivity' ? (inactivity_minutes || 5) : null,
                        is_active: is_active ?? true,
                        steps: Array.isArray(steps) ? steps : [],
                        store_id: storeId,
                        updated_at: new Date().toISOString()
                    })
                    .select()
                    .single();

                if (error) throw error;

                return {
                    success: true,
                    message: `Flujo "${newFlow.name}" creado correctamente`,
                    flow_id: newFlow.id,
                    trigger_type: newFlow.trigger_type,
                    steps_count: newFlow.steps?.length || 0
                };
            }

            case 'consultar_flujos_automatizacion': {
                const { data: flows, error } = await supabaseAdmin
                    .from('automation_flows')
                    .select('*')
                    .order('created_at', { ascending: false });

                if (error) throw error;

                return {
                    success: true,
                    count: flows?.length || 0,
                    flows: (flows || []).map(f => ({
                        id: f.id,
                        name: f.name,
                        trigger_type: f.trigger_type,
                        trigger_stage: f.trigger_stage,
                        inactivity_minutes: f.inactivity_minutes,
                        is_active: f.is_active,
                        steps_count: f.steps?.length || 0
                    }))
                };
            }

            case 'alternar_estado_flujo': {
                const { flowId, is_active } = args;
                const { data: updated, error } = await supabaseAdmin
                    .from('automation_flows')
                    .update({ is_active, updated_at: new Date().toISOString() })
                    .eq('id', flowId)
                    .select('id, name, is_active')
                    .single();

                if (error) throw error;

                return {
                    success: true,
                    message: `El flujo "${updated.name}" ahora está ${updated.is_active ? 'ACTIVO' : 'PAUSADO'}`,
                    flow: updated
                };
            }

            case 'consultar_prompt_comercial': {
                const details = await getPromptDetails();
                return {
                    success: true,
                    is_custom: details.is_custom,
                    last_updated: details.updated_at,
                    updated_by: details.updated_by,
                    prompt_preview: details.prompt ? details.prompt.slice(0, 500) + '...' : ''
                };
            }

            case 'actualizar_prompt_comercial': {
                const { nuevo_prompt, motivo } = args;
                const adminEmail = adminContext.adminEmail || 'admin@mas3.com';

                const audit = await analyzePromptToolGaps(nuevo_prompt);
                const saved = await saveSystemPrompt(nuevo_prompt, adminEmail);

                return {
                    success: true,
                    message: 'System Prompt actualizado y cargado en caliente en el agente comercial',
                    updated_at: saved.updated_at,
                    audit_has_gaps: audit?.has_gaps || false,
                    audit_notes: audit?.recommendation || ''
                };
            }

            case 'consultar_resumen_crm': {
                const { data: projects, error } = await supabaseAdmin
                    .from('projects')
                    .select('id, estatus_embudo, is_viable, budget_total, valor_cotizado_min, valor_cotizado_max');

                if (error) throw error;

                const stageCounts = OFFICIAL_STAGES.reduce((acc, st) => {
                    acc[st] = 0;
                    return acc;
                }, {});

                let totalPresupuesto = 0;
                for (const p of projects || []) {
                    const st = p.estatus_embudo || '4 - Escribió';
                    if (stageCounts[st] !== undefined) stageCounts[st]++;
                    else stageCounts[st] = 1;

                    if (p.budget_total) totalPresupuesto += Number(p.budget_total);
                }

                return {
                    success: true,
                    total_prospectos: projects?.length || 0,
                    resumen_por_etapa: stageCounts
                };
            }

            case 'consultar_prospectos_etapa': {
                const { etapa, limite = 10 } = args;
                const { data: projects, error } = await supabaseAdmin
                    .from('projects')
                    .select(`
                        id,
                        estatus_embudo,
                        budget_total,
                        valor_cotizado_min,
                        valor_cotizado_max,
                        fecha_next_action,
                        next_action,
                        chats (
                            id,
                            customer_phone,
                            users (
                                display_name,
                                phone_number
                            )
                        )
                    `)
                    .eq('estatus_embudo', etapa)
                    .order('updated_at', { ascending: false })
                    .limit(limite);

                if (error) throw error;

                const items = (projects || []).map(p => ({
                    project_id: p.id,
                    chat_id: p.chats?.id,
                    nombre: p.chats?.users?.display_name || 'Sin nombre registrado',
                    telefono: p.chats?.users?.phone_number || p.chats?.customer_phone || 'N/A',
                    proxima_accion: p.next_action,
                    fecha_proxima_accion: p.fecha_next_action,
                    presupuesto: p.budget_total ? `$${Number(p.budget_total).toLocaleString('es-CO')} COP` : 'No definido'
                }));

                return {
                    success: true,
                    etapa,
                    count: items.length,
                    prospectos: items
                };
            }

            case 'cambiar_etapa_prospecto': {
                const { chatIdOrPhone, nuevaEtapa } = args;

                if (!OFFICIAL_STAGES.includes(nuevaEtapa)) {
                    return {
                        success: false,
                        error: `Etapa inválida. Debe ser una de las 12 etapas oficiales: ${OFFICIAL_STAGES.join(', ')}`
                    };
                }

                // Buscar chat por ID o por teléfono
                let query = supabaseAdmin.from('chats').select('id, user_id');
                if (chatIdOrPhone.includes('-') && chatIdOrPhone.length > 20) {
                    query = query.eq('id', chatIdOrPhone);
                } else {
                    const cleanPhone = chatIdOrPhone.replace(/[^\d+]/g, '');
                    const { data: user } = await supabaseAdmin
                        .from('users')
                        .select('id')
                        .eq('phone_number', cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`)
                        .maybeSingle();

                    if (!user) {
                        return { success: false, error: `No se encontró usuario con el teléfono ${chatIdOrPhone}` };
                    }
                    query = query.eq('user_id', user.id);
                }

                const { data: chat } = await query.maybeSingle();
                if (!chat) {
                    return { success: false, error: 'No se encontró la conversación del cliente' };
                }

                await supabaseAdmin
                    .from('chats')
                    .update({ funnel_stage: nuevaEtapa, updated_at: new Date().toISOString() })
                    .eq('id', chat.id);

                await supabaseAdmin
                    .from('projects')
                    .update({ estatus_embudo: nuevaEtapa, updated_at: new Date().toISOString() })
                    .eq('chat_id', chat.id);

                return {
                    success: true,
                    message: `Cliente actualizado con éxito a la etapa "${nuevaEtapa}"`,
                    chat_id: chat.id,
                    nueva_etapa: nuevaEtapa
                };
            }

            case 'crear_tarea_equipo': {
                const { title, description, priority = 'MEDIUM', due_date } = args;
                const { data: newTask, error } = await supabaseAdmin
                    .from('tasks')
                    .insert({
                        title,
                        description: description || null,
                        priority: priority.toUpperCase(),
                        status: 'PENDING',
                        due_date: due_date || null,
                        created_by: adminContext.adminId || null,
                        updated_at: new Date().toISOString()
                    })
                    .select()
                    .single();

                if (error) throw error;

                return {
                    success: true,
                    message: `Tarea "${newTask.title}" registrada exitosamente en el módulo de tareas`,
                    task_id: newTask.id
                };
            }

            default:
                return { success: false, error: `Herramienta desconocida: ${toolName}` };
        }
    } catch (err) {
        logger.error(`AdminCopilot: Error executing tool ${toolName}`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Servicio Exportado del Admin Copilot
 */
export const adminCopilotService = {
    /**
     * Procesa un turno de conversación del administrador (Web o WhatsApp)
     * @param {Object} params
     * @param {string} params.sessionId - Identificador de sesión (ej: admin_web_123 o admin_wa_+57300...)
     * @param {string} params.message - Texto del mensaje del admin
     * @param {Object} [params.adminContext] - Datos del admin (adminId, adminEmail, adminPhone, source)
     * @returns {Promise<{ reply: string, executedTools: Array, sessionId: string }>}
     */
    async chat({ sessionId, message, adminContext = {} }) {
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            throw new Error('El mensaje no puede estar vacío');
        }

        const history = getSessionHistory(sessionId);

        // Añadir mensaje del admin al historial
        history.push({ role: 'user', content: message.trim() });

        // Mantener ventana de contexto segura (últimos 20 turnos + system prompt)
        if (history.length > 25) {
            const systemMsg = history[0];
            const recent = history.slice(-24);
            history.length = 0;
            history.push(systemMsg, ...recent);
        }

        const executedTools = [];
        let iterations = 0;
        const MAX_TOOL_ITERATIONS = 5;

        while (iterations < MAX_TOOL_ITERATIONS) {
            iterations++;

            logger.info('AdminCopilot: Calling OpenAI', { sessionId, iteration: iterations, historyLen: history.length });

            const response = await openai.chat.completions.create({
                model: process.env.ADMIN_COPILOT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
                messages: history,
                tools: COPILOT_TOOLS,
                tool_choice: 'auto',
                temperature: 0.3 // Temperatura controlada para precisión ejecutiva
            });

            const choice = response.choices?.[0];
            const assistantMessage = choice?.message;

            if (!assistantMessage) {
                throw new Error('No se recibió respuesta válida del modelo');
            }

            // Registrar mensaje del asistente en el historial
            history.push(assistantMessage);

            // Si el modelo solicita ejecutar herramientas
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                for (const toolCall of assistantMessage.tool_calls) {
                    const funcName = toolCall.function.name;
                    let parsedArgs = {};
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (pErr) {
                        logger.error('AdminCopilot: Failed to parse tool arguments JSON', pErr);
                    }

                    const toolResult = await executeAdminTool(funcName, parsedArgs, adminContext);

                    executedTools.push({
                        tool_name: funcName,
                        args: parsedArgs,
                        result: toolResult
                    });

                    // Añadir respuesta de la herramienta al historial
                    history.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(toolResult)
                    });
                }
                // Continuar el bucle para que el modelo redacte su respuesta con los datos de las herramientas
            } else {
                // El modelo respondió directamente al usuario
                return {
                    reply: assistantMessage.content || '',
                    executedTools,
                    sessionId
                };
            }
        }

        // Si superó el límite de iteraciones de herramientas
        const lastMsg = history[history.length - 1];
        return {
            reply: lastMsg?.content || 'Operación completada con éxito.',
            executedTools,
            sessionId
        };
    },

    /**
     * Limpia el historial de una sesión del administrador
     */
    clearSession(sessionId) {
        if (sessionsStore.has(sessionId)) {
            sessionsStore.delete(sessionId);
        }
        return { success: true };
    },

    /**
     * Retorna el historial actual de una sesión
     */
    getSessionMessages(sessionId) {
        const history = sessionsStore.get(sessionId) || [];
        return history.filter(m => m.role === 'user' || m.role === 'assistant');
    },

    /**
     * Verifica si un número de teléfono pertenece a un administrador autorizado
     */
    async isAuthorizedAdminPhone(phoneNumber) {
        if (!phoneNumber) return false;
        const clean = String(phoneNumber).replace(/[^\d+]/g, '');

        // 1. Verificar variable de entorno ADMIN_PHONE_NUMBERS (ej: "+573001234567,+57310...")
        const envAdmins = (process.env.ADMIN_PHONE_NUMBERS || '')
            .split(',')
            .map(p => p.trim().replace(/[^\d+]/g, ''))
            .filter(Boolean);

        if (envAdmins.some(adminPhone => clean === adminPhone || clean.endsWith(adminPhone.replace('+', '')))) {
            return true;
        }

        // 2. Verificar en public.profiles si existe algún usuario ADMIN con este teléfono
        try {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('id, role')
                .eq('role', 'ADMIN')
                .maybeSingle();

            // Si el admin principal está registrado
            if (profile) {
                const { data: user } = await supabaseAdmin
                    .from('users')
                    .select('phone_number')
                    .eq('id', profile.id)
                    .maybeSingle();

                if (user?.phone_number && user.phone_number.includes(clean.replace('+', ''))) {
                    return true;
                }
            }
        } catch (_) {}

        return false;
    }
};
