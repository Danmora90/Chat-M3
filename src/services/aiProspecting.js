import OpenAI from 'openai';
import { logger } from '../middleware/logger.js';

/**
 * Servicio de Inteligencia Artificial con OpenAI para calificar comentarios
 * de Instagram y generar mensajes directos (DM) personalizados para MAS.3.
 */

const SYSTEM_PROMPT = `
Eres el Director de Desarrollo de Negocios y Arquitectura de MAS.3, un exclusivo estudio de arquitectura, diseño interior y remodelación de apartamentos y casas de alto nivel.
Tu tarea es analizar comentarios en publicaciones o Reels de empresas competidoras del sector de remodelación y diseño para identificar potenciales clientes calificados.

Criterios de Calificación:
1. Prospectos VÁLIDOS (Intención real de remodelación/diseño):
   - Personas que preguntan precios, costos por m2, cotizaciones, cobertura de ciudad o tiempos de obra.
   - Personas que expresan interés directo en remodelar su cocina, baño, sala o apartamento completo.
   - Personas que responden a llamadas a la acción (Call to Action / Lead Magnets) del post con palabras como: "Obra", "Info", "Precio", "Cocina", "Detalles", "Me interesa", "Quiero cotizar", etc.
2. Descarta rigurosamente:
   - Cuentas de otras empresas, marcas comerciales o negocios competidores.
   - Colegas arquitectos o constructoras que elogian técnicamente como pares (ej. "Gran trabajo colega", "Buen render").
   - Proveedores de materiales o ventas de insumos.
   - Emojis sueltos sin texto (ej. solo "😍", "🔥", "👏").
   - Spam o bots.
3. Selecciona un MÁXIMO de 2 prospectos calificados del lote. Si no hay comentarios que cumplan el criterio de compra real, devuelve el JSON con la clave leads vacía: { "leads": [] }.

Para cada prospecto seleccionado genera:
- username: El @username exacto del usuario (sin @ inicial).
- ai_intent_score: Justificación muy breve (1 línea) explicando por qué muestra intención real de remodelación/diseño (ej. "Respondió a la convocatoria con palabra clave para cotizar cocina").
- suggested_dm: Un mensaje directo cálido, profesional, empático y 100% natural de primer contacto de entre 35 y 60 palabras, SIN enlaces web ni URLs, redactado en tono humano.
  * Debe hacer referencia sutil y contextual al interés expresado (ej. cocina a medida, remodelación de apartamento, acabados).
  * Pone a MAS.3 a su completa disposición para asesorarle y prepararle una propuesta personalizada sin compromiso.

Devuelve estrictamente un objeto JSON con la clave "leads":
{
  "leads": [
    {
      "username": "usuario_ejemplo",
      "ai_intent_score": "Respondió con palabra clave para cotizar remodelación de cocina",
      "suggested_dm": "Hola Juan, vi tu interés en los acabados de cocina. En MAS.3 diseñamos y remodelamos espacios a medida para que disfrutes cada rincón de tu hogar. Nos encantaría asesorarte y preparar una propuesta personalizada sin compromiso cuando desees."
    }
  ]
}
`;

/**
 * Califica una lista de comentarios de un post y genera propuestas de DM usando OpenAI
 * @param {Array<{username: string, full_name?: string, comment_text: string}>} comments
 * @param {Object} [postContext] - Datos del post (url, descripción breve de la empresa)
 * @returns {Promise<Array<{username: string, ai_intent_score: string, suggested_dm: string}>>}
 */
export async function qualifyCommentsAndGenerateDMs(comments, postContext = {}) {
    if (!comments || !Array.isArray(comments) || comments.length === 0) {
        return [];
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const errorMsg = 'Falta OPENAI_API_KEY en el entorno (.env). No se puede realizar la calificación con IA.';
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Modelo configurable, fallback a gpt-4o o gpt-4o-mini
    const model = process.env.OPENAI_MODEL || 'gpt-4o';

    const openai = new OpenAI({ apiKey });

    const commentsPayload = comments.map((c, i) => ({
        index: i + 1,
        username: c.username,
        full_name: c.full_name || '',
        comment_text: c.comment_text
    }));

    const userPrompt = `
Contexto de la publicación:
- URL del Post: ${postContext.postUrl || 'No especificada'}
- Empresa origen: ${postContext.companyUsername ? '@' + postContext.companyUsername : 'Empresa del sector'}

Comentarios a evaluar:
${JSON.stringify(commentsPayload, null, 2)}

Instrucción:
Analiza estos comentarios realizados en la publicación de remodelación y diseño de interiores.
Selecciona únicamente los (máximo) 2 usuarios que muestren mayor intención real de compra o interés genuino en remodelar o diseñar su espacio.
Devuelve el resultado estrictamente en formato JSON con la clave "leads".
`;

    try {
        const completion = await openai.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3
        });

        const rawText = completion.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(rawText);

        const list = Array.isArray(parsed) ? parsed : (parsed.leads || parsed.prospects || []);

        if (!Array.isArray(list)) {
            logger.warn('La respuesta de OpenAI no contiene un array válido de leads:', { parsed });
            return [];
        }

        // Asegurar que no exceda 2 prospectos calificados
        const qualifiedLeads = list.slice(0, 2).map(lead => ({
            username: (lead.username || '').replace(/^@/, '').trim().toLowerCase(),
            ai_intent_score: lead.ai_intent_score || 'Interés detectado en remodelación/diseño',
            suggested_dm: (lead.suggested_dm || '').trim()
        })).filter(l => l.username.length > 0 && l.suggested_dm.length > 0);

        logger.info(`OpenAI (${model}) calificó ${qualifiedLeads.length} prospecto(s) válido(s) de ${comments.length} comentarios evaluados.`);
        return qualifiedLeads;

    } catch (err) {
        logger.error('Error al calificar comentarios con OpenAI:', { error: err.message });
        throw err;
    }
}
