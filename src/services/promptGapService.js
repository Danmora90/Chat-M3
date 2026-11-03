import OpenAI from 'openai';
import { supabaseAdmin } from './supabase.js';
import { logger } from '../middleware/logger.js';

const NATIVE_TOOLS_CATALOG = [
    {
        name: 'buscar_materiales',
        display_name: 'Buscar Materiales y Acabados',
        description: 'Consulta catálogo de materiales, porcelanatos, pisos, pinturas y precios por unidad o m².',
        tool_type: 'native'
    },
    {
        name: 'busqueda_web',
        display_name: 'Búsqueda en la Web',
        description: 'Busca información general en internet sobre constructoras, proyectos o referencias.',
        tool_type: 'native'
    },
    {
        name: 'actualizar_nombre_usuario',
        display_name: 'Actualizar Nombre del Cliente',
        description: 'Actualiza el nombre de pila o nombre completo del usuario en su perfil.',
        tool_type: 'native'
    },
    {
        name: 'cotizador_proyectos',
        display_name: 'Cotizador de Remodelación',
        description: 'Calcula estimaciones de costos y presupuestos para remodelaciones según m² y alcance.',
        tool_type: 'native'
    },
    {
        name: 'registrar_venta',
        display_name: 'Registrar Pago / Venta',
        description: 'Registra un abono, anticipo o comprobante de pago recibido de un cliente.',
        tool_type: 'native'
    },
    {
        name: 'update_chat_tag',
        display_name: 'Etiquetar Conversación',
        description: 'Actualiza la etiqueta de intención del chat (diseño, cotización, dudas_materiales, viabilidad_negativa, adelanto_pagado).',
        tool_type: 'native'
    },
    {
        name: 'agendar_reunion',
        display_name: 'Agendar Reunión en Google Calendar',
        description: 'Agenda reuniones en Google Calendar y genera enlaces de Google Meet cuando el cliente confirma fecha y hora.',
        tool_type: 'native'
    },
    {
        name: 'sincronizar_crm',
        display_name: 'Sincronizar CRM',
        description: 'Sincroniza y guarda datos clave del cliente, proyecto y presupuesto en el CRM de Supabase.',
        tool_type: 'native'
    },
    {
        name: 'buscar_proyecto_inmobiliario',
        display_name: 'Buscar Proyectos Inmobiliarios',
        description: 'Busca proyectos residenciales y apartamentos en Bogotá y Cundinamarca.',
        tool_type: 'native'
    }
];

/**
 * Obtiene el catálogo completo de herramientas disponibles (Nativas + Dinámicas activas)
 */
async function getAllAvailableTools() {
    let customTools = [];
    try {
        const { data, error } = await supabaseAdmin
            .from('custom_tools')
            .select('name, display_name, description, tool_type, parameters')
            .eq('is_active', true);

        if (!error && data) {
            customTools = data.map(t => ({
                name: t.name,
                display_name: t.display_name || t.name,
                description: t.description || '',
                tool_type: t.tool_type,
                parameters: t.parameters || []
            }));
        }
    } catch (err) {
        logger.warn('promptGapService: Error fetching custom tools for audit', { error: err.message });
    }

    return [...NATIVE_TOOLS_CATALOG, ...customTools];
}

/**
 * Analiza un System Prompt y detecta si contiene instrucciones o tareas que requieran tools no existentes.
 * @param {string} promptText - Texto completo del prompt a auditar
 * @returns {Promise<{ has_missing_tools: boolean, missing_tools: Array<Object>, summary: string }>}
 */
export async function analyzePromptToolGaps(promptText) {
    if (!promptText || typeof promptText !== 'string' || promptText.trim().length < 10) {
        return {
            has_missing_tools: false,
            missing_tools: [],
            summary: 'Prompt demasiado corto para analizar.'
        };
    }

    const availableTools = await getAllAvailableTools();

    const toolsDescription = availableTools.map((t, idx) => 
        `${idx + 1}. [${t.name}] (${t.display_name}): ${t.description}`
    ).join('\n');

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const systemPrompt = `Eres un auditor técnico de agentes de Inteligencia Artificial para atención al cliente y ventas por WhatsApp.
Tu misión es analizar el "System Prompt" proporcionado por el usuario y contrastarlo contra el "Catálogo de Herramientas (Tools) Disponibles" en la plataforma.

CATÁLOGO DE HERRAMIENTAS DISPONIBLES EN EL SISTEMA:
${toolsDescription}

REGLAS DE AUDITORÍA:
1. Examina las reglas, instrucciones y directivas del System Prompt.
2. Identifica si hay instrucciones explícitas donde se le ordene a la IA ejecutar una ACCIÓN OPERATIVA, TRANSACCIONAL O DE INTEGRACIÓN (por ejemplo: enviar un correo electrónico, modificar estados o campos de un usuario en la base de datos, pausar el asistente, generar facturas, enviar notificaciones push/SMS, registrar datos en servicios externos) para la cual NO exista una herramienta adecuada en el catálogo anterior.
3. NO consideres como faltante nada que la IA pueda resolver puramente conversando (ejemplo: redactar mensajes, responder amablemente, formular preguntas, recomendar materiales si ya tiene buscar_materiales, calcular m2 si ya tiene cotizador_proyectos, o agendar citas si ya tiene agendar_reunion).
4. Solo reporta ACCIONES que requieran interactuar con el sistema, bases de datos o servicios externos que no tengan herramienta.
5. Si no hay herramientas faltantes (todo está cubierto o son solo instrucciones conversacionales), retorna missing_tools como un arreglo vacío [].
6. Para cada herramienta faltante detectada, genera una propuesta de configuración lista para ser creada:
   - action_title: Título conciso de la tarea requerida (ej: "Enviar Correo Electrónico")
   - rule_snippet: Fragmento textual de la regla en el prompt donde se pide dicha tarea
   - reason: Explicación de por qué se necesita crear una tool para esta instrucción
   - suggested_tool:
     - name: slug técnico en minúsculas con guiones bajos (ej: "enviar_correo_cotizacion", "pausar_asistente_humano")
     - display_name: Nombre legible (ej: "Enviar Cotización por Correo")
     - description: Explicación semántica para el modelo de OpenAI de cuándo y cómo llamarla
     - tool_type: 'database_action' (si es modificar/consultar base de datos o estado del chat) o 'http_request' (si es enviar correo, llamar API externa o webhook)
     - parameters: Arreglo de parámetros que la IA debe extraer [{ "name": "...", "type": "string"|"number"|"boolean", "description": "...", "required": true|false }]
     - execution_config:
         Si es database_action: { "table": "chats"|"users"|"projects", "action": "update"|"insert", "target": "current_chat"|"current_user", "field_mappings": { ... }, "success_message": "..." }
         Si es http_request: { "url": "https://api.resend.com/emails", "method": "POST", "headers": { "Content-Type": "application/json" }, "body_template": "...", "success_message": "..." }

DEBES RESPONDER EXCLUSIVAMENTE UN OBJETO JSON VÁLIDO con la siguiente estructura:
{
  "has_missing_tools": boolean,
  "summary": string,
  "missing_tools": [
    {
      "action_title": string,
      "rule_snippet": string,
      "reason": string,
      "suggested_tool": {
        "name": string,
        "display_name": string,
        "description": string,
        "tool_type": "database_action" | "http_request",
        "parameters": [
          { "name": string, "type": string, "description": string, "required": boolean }
        ],
        "execution_config": object
      }
    }
  ]
}`;

    try {
        logger.info('promptGapService: Analyzing prompt for tool gaps', {
            promptLength: promptText.length,
            availableToolsCount: availableTools.length
        });

        const response = await openai.chat.completions.create({
            model,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analiza el siguiente System Prompt:\n\n${promptText}` }
            ]
        });

        const rawContent = response.choices?.[0]?.message?.content;
        if (!rawContent) {
            throw new Error('Respuesta vacía del analizador de OpenAI');
        }

        const parsed = JSON.parse(rawContent);

        const missingTools = Array.isArray(parsed.missing_tools) ? parsed.missing_tools : [];
        const hasMissingTools = missingTools.length > 0;

        logger.info('promptGapService: Audit completed', {
            hasMissingTools,
            missingToolsCount: missingTools.length
        });

        return {
            has_missing_tools: hasMissingTools,
            summary: parsed.summary || (hasMissingTools 
                ? `Se detectaron ${missingTools.length} acciones que requieren nuevas herramientas.` 
                : 'Todas las tareas exigidas en el prompt cuentan con herramientas disponibles.'),
            missing_tools: missingTools
        };
    } catch (error) {
        logger.error('promptGapService: Failed to analyze prompt gaps', error);
        throw error;
    }
}
