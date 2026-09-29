import axios from 'axios';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import https from 'https';
import { supabaseAdmin } from './supabase.js';
import { logger } from '../middleware/logger.js';

// Agente HTTPS para sitios corporativos de constructoras colombianas
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3'
};

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Dominios permitidos: EXCLUSIVAMENTE CONSTRUCTORAS OFICIALES (Cero portales)
const ALLOWED_BUILDER_DOMAINS = [
    'cusezar.com',
    'amarilo.com.co',
    'amarilo.com',
    'constructorabolivar.com',
    'constructoracapital.com',
    'marval.com.co',
    'galias.com.co',
    'lasgalias.com.co',
    'prodesa.com',
    'arquitecturayconcreto.com'
];

/**
 * Resuelve URLs relativas a absolutas
 */
function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return null;
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
        return relativeUrl;
    }
    try {
        const parsedBase = new URL(baseUrl);
        return new URL(relativeUrl, parsedBase.origin).href;
    } catch (e) {
        return null;
    }
}

/**
 * Obtiene candidatos de proyectos oficiales directamente de las constructoras usando Serper con consultas dirigidas
 */
async function harvestOfficialBuilderCandidates(city = 'Bogotá', year = '2026', semester = 'all') {
    const candidates = [];
    const seenLinks = new Set();

    // Determinar término semestral para la consulta de Google
    let semesterTerm = `("${year}" OR "entrega ${year}")`;
    if (semester === '1') {
        semesterTerm = `("primer semestre ${year}" OR "1er semestre ${year}" OR "inicios de ${year}" OR "${year}")`;
    } else if (semester === '2') {
        semesterTerm = `("segundo semestre ${year}" OR "2do semestre ${year}" OR "finales de ${year}" OR "${year}")`;
    }

    // Ubicación geográfica: si es 'all' o 'Cundinamarca', buscar ampliamente
    const isAllCundinamarca = !city || city === 'all' || city === 'Cundinamarca' || city === 'Todas';
    const locationQuery = isAllCundinamarca
        ? '(Bogota OR Cundinamarca OR Chia OR Cajica OR Mosquera OR Madrid OR Soacha)'
        : `"${city}"`;

    const queries = [
        `${semesterTerm} ${locationQuery} (site:amarilo.com.co/proyecto/ OR site:galias.com.co/proyectos-en-venta/)`,
        `${semesterTerm} ${locationQuery} (site:constructorabolivar.com/proyectos-vivienda/ OR site:constructoracapital.com/proyecto/)`,
        `${semesterTerm} ${locationQuery} (site:proyectos.marval.com.co OR site:cusezar.com/proyectos/)`,
        `${semesterTerm} ${locationQuery} (site:prodesa.com OR site:arquitecturayconcreto.com)`
    ];

    if (process.env.SERPER_API_KEY) {
        await Promise.allSettled(queries.map(async (q) => {
            try {
                const res = await axios.post(
                    'https://google.serper.dev/search',
                    { q, gl: 'co', hl: 'es', num: 8 },
                    {
                        headers: {
                            'X-API-KEY': process.env.SERPER_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        timeout: 5000
                    }
                );
                (res.data?.organic || []).forEach(item => {
                    if (item.link) {
                        const cleanLink = item.link.split('?')[0].trim();
                        const lower = cleanLink.toLowerCase();
                        if (
                            ALLOWED_BUILDER_DOMAINS.some(dom => lower.includes(dom)) &&
                            !lower.includes('fincaraiz') &&
                            !lower.includes('metrocuadrado') &&
                            !lower.includes('ciencuadras') &&
                            !lower.includes('/blog/') &&
                            !cleanLink.endsWith('/bogota') &&
                            !cleanLink.endsWith('/bogota/') &&
                            !seenLinks.has(cleanLink)
                        ) {
                            seenLinks.add(cleanLink);
                            candidates.push({
                                url: cleanLink,
                                title: item.title || '',
                                snippet: item.snippet || ''
                            });
                        }
                    }
                });
            } catch (err) {
                logger.warn(`Serper query error for ${q}: ${err.message}`);
            }
        }));
    }

    return candidates;
}

/**
 * Evalúa y extrae los datos de un proyecto oficial individual
 */
async function evaluateOfficialProject({ candidate, city = 'Bogotá', year = '2026', semester = 'all' }) {
    const projectUrl = candidate.url;
    try {
        const pageResp = await axios.get(projectUrl, {
            timeout: 6000,
            httpsAgent,
            headers: browserHeaders
        });

        const $ = cheerio.load(pageResp.data);

        const rawTitle = $('title').text().trim().replace(/[\n\r\t]+/g, ' ');
        const metaOgImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        const resolvedOg = resolveUrl(projectUrl, metaOgImage);

        const blueprintImages = [];
        const renderImages = [];

        $('img, picture source').each((_, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('srcset') || $(el).attr('data-lazy-src');
            const alt = ($(el).attr('alt') || '').toLowerCase();
            const resolved = resolveUrl(projectUrl, src?.split(' ')[0]);

            if (!resolved) return;
            const lowerSrc = resolved.toLowerCase();

            if (lowerSrc.endsWith('.svg') || lowerSrc.includes('logo') || lowerSrc.includes('icon') || lowerSrc.includes('pixel') || lowerSrc.includes('marker')) {
                return;
            }

            if (
                lowerSrc.includes('plano') ||
                lowerSrc.includes('planta') ||
                lowerSrc.includes('tipologia') ||
                lowerSrc.includes('topologia') ||
                lowerSrc.includes('distribuc') ||
                lowerSrc.includes('tipo-') ||
                lowerSrc.includes('tipo_') ||
                alt.includes('plano') ||
                alt.includes('planta') ||
                alt.includes('tipologia') ||
                alt.includes('distribucion')
            ) {
                blueprintImages.push(resolved);
            } else if (
                lowerSrc.includes('fachada') ||
                lowerSrc.includes('render') ||
                lowerSrc.includes('perspectiva') ||
                lowerSrc.includes('galeria') ||
                lowerSrc.includes('banner') ||
                lowerSrc.includes('apto')
            ) {
                renderImages.push(resolved);
            }
        });

        $('script, style, noscript, iframe, svg, nav, footer, header').remove();
        const fullText = $('body').text().replace(/\s+/g, ' ').trim();

        // Extracción inteligente de ventanas de texto con términos clave
        let smartExtract = fullText.slice(0, 2000);
        const keywords = ['entrega', 'fecha', 'semestre', 'etapa', year, 'chía', 'cajicá', 'estrato', 'área', 'torre'];
        for (const kw of keywords) {
            let idx = fullText.toLowerCase().indexOf(kw);
            while (idx !== -1 && idx < fullText.length) {
                smartExtract += ' ... ' + fullText.slice(Math.max(0, idx - 120), Math.min(fullText.length, idx + 250));
                idx = fullText.toLowerCase().indexOf(kw, idx + 350);
            }
        }
        smartExtract = smartExtract.slice(0, 6000);

        const heroImage = resolvedOg || renderImages[0] || blueprintImages[0] || '';

        const extractionPrompt = `Analiza este proyecto inmobiliario en Colombia de una constructora oficial:
URL: ${projectUrl}
TÍTULO: ${rawTitle}
GOOGLE SNIPPET: ${candidate.snippet}
CONTENIDO DE LA PÁGINA: ${smartExtract}
PLANOS IDENTIFICADOS: ${JSON.stringify(blueprintImages.slice(0, 5))}
RENDERS IDENTIFICADOS: ${JSON.stringify(renderImages.slice(0, 3))}

CRITERIOS DE EXTRACCIÓN:
- Ciudad / Municipio: Especifica si es Bogotá D.C., Chía, Cajicá, Zipaquirá, Mosquera, Madrid, Funza, Sopó, Cota, Soacha, Ricaurte, Girardot, etc.
- Fecha de entrega:
  * Si dice "Entrega inmediata", "Terminado", o ya construido -> delivery_status: "inmediata".
  * Si no hay fecha mencionada, o dice "No especificada" / "A determinar" -> delivery_status: "indefinida".
  * Si menciona un año o semestre futuro (ej: "${year}", "Segundo semestre ${year}", "Noviembre ${year}") -> delivery_status: "concreta".
- Semestre:
  * Si es primer semestre -> delivery_semester: "1".
  * Si es segundo semestre o último trimestre -> delivery_semester: "2".
  * Si menciona sólo el año o abarca todo el año -> delivery_semester: "all".

JSON exacto:
{
  "name": "Nombre exacto del proyecto",
  "builder": "Amarilo | Constructora Bolívar | Cusezar | Constructora Capital | Las Galias | Marval | Prodesa | Arquitectura y Concreto",
  "city": "Ciudad o Municipio (ej: Bogotá, Chía, Cajicá, Mosquera, Zipaquirá)",
  "stratum": número de estrato (4, 5 o 6, o 3 si es VIS),
  "zone": "Barrio, sector o vereda",
  "delivery_text": "Texto literal oficial de entrega que figure en la web o snippet (ej: 'Segundo semestre ${year}', 'Noviembre ${year}', '2026', 'Entrega inmediata')",
  "delivery_status": "concreta" | "inmediata" | "indefinida",
  "delivery_year": "año a 4 dígitos ej: '${year}' o null",
  "delivery_semester": "1" | "2" | "all",
  "delivery_month": "mes de 2 dígitos si figura explícito ej: '11', '05' o null",
  "description": "2 líneas concisas describiendo el proyecto",
  "typologies": [
    {
      "name": "Nombre de la tipología (ej. Tipo 68m²)",
      "area_m2": número del área en m2,
      "bedrooms": número de alcobas,
      "bathrooms": número de baños,
      "blueprint_url": "URL exacta de la imagen del plano real extraído"
    }
  ]
}`;

        const aiResp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'Analista inmobiliario. Extrae datos fidedignos únicamente del sitio oficial.' },
                { role: 'user', content: extractionPrompt }
            ],
            temperature: 0.0,
            max_tokens: 850
        });

        let parsed = {};
        try {
            parsed = JSON.parse(aiResp.choices[0]?.message?.content || '{}');
        } catch (jsonErr) {
            logger.warn(`Could not parse project JSON from ${projectUrl}: ${jsonErr.message}`);
            return null;
        }

        const lowerName = (parsed.name || '').toLowerCase();
        const lowerCity = (parsed.city || '').toLowerCase();
        const lowerDelivery = (parsed.delivery_text || '').toLowerCase();

        // Descartar si es de otra región lejana (costa caribe, cali, antioquia, santander)
        if (lowerCity.includes('barranquilla') || lowerCity.includes('cali') || lowerCity.includes('cartagena') ||
            lowerCity.includes('bucaramanga') || lowerCity.includes('medell') || lowerCity.includes('valle del cauca') ||
            lowerCity.includes('barranquilla') || lowerCity.includes('santa marta')) {
            return null;
        }

        const isImmediate = parsed.delivery_status === 'inmediata' ||
                            lowerDelivery.includes('inmediata') ||
                            lowerDelivery.includes('inmediato');

        const isUndetermined = parsed.delivery_status === 'indefinida' ||
                               lowerDelivery.includes('no especifica') ||
                               lowerDelivery.includes('a determinar') ||
                               lowerDelivery.includes('a definir') ||
                               lowerDelivery.includes('por definir') ||
                               lowerDelivery === 'null' ||
                               !parsed.delivery_text;

        // Validaciones estrictas de fecha:        // En escaneo periódico se descartan inmediatas e indefinidas
        if (semester !== 'direct_search' && (isImmediate || isUndetermined)) {
            return null;
        }
        if (parsed.delivery_year && year && year !== 'all' && String(parsed.delivery_year) !== String(year)) {
            return null;
        }

        // Validación semestral si se solicitó un semestre específico
        if (semester === '1') {
            if (parsed.delivery_semester === '2') return null;
            if (lowerDelivery.includes('segundo semestre') && !lowerDelivery.includes('primer semestre')) return null;
        } else if (semester === '2') {
            if (parsed.delivery_semester === '1') return null;
            if (lowerDelivery.includes('primer semestre') && !lowerDelivery.includes('segundo semestre')) return null;
        }

        if (parsed.name && parsed.name.length > 2 && !lowerName.includes('no se pudo') && !lowerName.startsWith('proyectos de vivienda')) {
            const cleanTypologies = (parsed.typologies || []).map((t, idx) => ({
                name: t.name || `Tipología ${idx + 1}`,
                area_m2: Number(t.area_m2) || 68,
                bedrooms: Number(t.bedrooms) || 2,
                bathrooms: Number(t.bathrooms) || 2,
                has_balcony: true,
                blueprint_url: t.blueprint_url || blueprintImages[idx] || blueprintImages[0] || renderImages[idx] || heroImage
            }));

            if (cleanTypologies.length === 0) {
                const fallbackImages = blueprintImages.length > 0 ? blueprintImages : renderImages.length > 0 ? renderImages : [heroImage];
                fallbackImages.slice(0, 3).forEach((bp, idx) => {
                    cleanTypologies.push({
                        name: `Tipo ${String.fromCharCode(65 + idx)}`,
                        area_m2: 65 + idx * 15,
                        bedrooms: 2 + (idx > 0 ? 1 : 0),
                        bathrooms: 2,
                        has_balcony: true,
                        blueprint_url: bp
                    });
                });
            }

            const effectiveCity = parsed.city || city || 'Bogotá';
            const slugName = parsed.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
            const citySlug = effectiveCity.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
            const semTag = semester === '1' ? 's1' : semester === '2' ? 's2' : 'all';
            const safeId = `proj-${slugName}-${citySlug}-${year}-${semTag}`;

            let builderName = parsed.builder;
            if (!builderName || builderName.includes('Constructora') || builderName === 'Constructora Oficial') {
                if (projectUrl.includes('cusezar')) builderName = 'Cusezar';
                else if (projectUrl.includes('amarilo')) builderName = 'Amarilo';
                else if (projectUrl.includes('constructorabolivar')) builderName = 'Constructora Bolívar';
                else if (projectUrl.includes('constructoracapital')) builderName = 'Constructora Capital';
                else if (projectUrl.includes('galias')) builderName = 'Las Galias';
                else if (projectUrl.includes('marval')) builderName = 'Marval';
                else if (projectUrl.includes('prodesa')) builderName = 'Prodesa';
            }

            // Identificar mes para delivery_month si viene o asignar S1 / S2
            const monthVal = parsed.delivery_month || (semester === '1' ? 'S1' : semester === '2' ? 'S2' : null);

            return {
                id: safeId,
                name: parsed.name,
                builder: builderName || 'Constructora Oficial',
                stratum: Number(parsed.stratum) || 4,
                zone: parsed.zone || effectiveCity,
                city: effectiveCity,
                delivery_date: (parsed.delivery_text || `${year}`).toUpperCase(),
                delivery_month: monthVal,
                delivery_year: String(parsed.delivery_year || year),
                project_url: projectUrl,
                hero_image: heroImage,
                description: parsed.description || `Proyecto de vivienda nueva por ${builderName} en ${effectiveCity}.`,
                typologies: cleanTypologies,
                scouted_at: new Date().toISOString()
            };
        }

        return null;
    } catch (err) {
        logger.warn(`Error evaluating project ${projectUrl}: ${err.message}`);
        return null;
    }
}

/**
 * Escanea EXCLUSIVAMENTE páginas oficiales de constructoras en Bogotá y Cundinamarca por año y semestre
 */
export async function scanResidentialProjects({ city = 'Bogotá', year = '2026', semester = 'all', strata = [4, 5, 6] }) {
    logger.info('Starting official builder projects scan', { city, year, semester, strata });

    const strataSet = new Set(strata.map(s => Number(s)));

    // 1. Obtener candidatos con consultas dirigidas por año, semestre y ubicación
    const candidates = await harvestOfficialBuilderCandidates(city, year, semester);
    logger.info(`Harvested ${candidates.length} targeted builder candidates for ${city} - ${year} (Semestre: ${semester}).`);

    if (candidates.length === 0) {
        logger.warn('No official builder candidate URLs found.');
        return [];
    }

    // 2. Evaluar candidatos concurrentemente con Promise.allSettled
    logger.info(`Evaluating ${candidates.length} candidate projects concurrently...`);
    const evaluationResults = await Promise.allSettled(
        candidates.slice(0, 15).map(cand => evaluateOfficialProject({
            candidate: cand,
            city,
            year,
            semester
        }))
    );

    const discoveredProjects = [];
    evaluationResults.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
            discoveredProjects.push(r.value);
        }
    });

    let filteredProjects = discoveredProjects.filter(p => strataSet.has(p.stratum));
    if (filteredProjects.length === 0 && discoveredProjects.length > 0) {
        filteredProjects = discoveredProjects;
    }

    logger.info(`Validated ${filteredProjects.length} matching official projects.`);

    // 3. Generar el insight comercial con IA para MAS.3
    if (filteredProjects.length > 0) {
        try {
            const listStr = filteredProjects.map(p => `${p.name} (${p.builder}, ${p.city} - ${p.zone}, Estrato ${p.stratum})`).join(' | ');
            const aiInsight = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'Eres el estratega comercial de arquitectura de MAS.3 en Bogotá y Cundinamarca. Resume en 2 párrafos concisos la oportunidad de negocio para contactar a estos proyectos y ofrecer paquetes de acabados/remodelación antes de su entrega.'
                    },
                    {
                        role: 'user',
                        content: `Proyectos reales identificados directamente de constructoras oficiales: ${listStr}`
                    }
                ],
                max_tokens: 280,
                temperature: 0.4
            });

            const commercialText = aiInsight.choices[0]?.message?.content?.trim();
            filteredProjects.forEach(p => {
                p.commercial_insight = commercialText;
            });
        } catch (e) {
            logger.warn(`Could not generate insight: ${e.message}`);
        }
    }

    // 4. GUARDAR DIRECTAMENTE EN SUPABASE
    if (filteredProjects.length > 0) {
        try {
            const { error: upsertError } = await supabaseAdmin
                .from('scouted_projects')
                .upsert(filteredProjects);

            if (upsertError) {
                logger.error('Error saving projects to Supabase:', upsertError);
            } else {
                logger.info(`Successfully stored ${filteredProjects.length} official builder projects in Supabase.`);
            }
        } catch (dbErr) {
            logger.error('Supabase upsert exception:', dbErr);
        }
    }

    return filteredProjects;
}

/**
 * Busca proyectos ÚNICAMENTE en la base de datos local (Supabase).
 * Utilizado por el buscador del panel administrativo (no rastrea internet).
 */
export async function searchLocalScoutedProjects({ projectName, city } = {}) {
    if (!projectName || !projectName.trim()) {
        return [];
    }
    const cleanName = projectName.trim();
    logger.info(`Searching local scouted projects for: "${cleanName}" in city: ${city || 'any'}`);

    try {
        let query = supabaseAdmin
            .from('scouted_projects')
            .select('*')
            .ilike('name', `%${cleanName}%`);

        if (city && city !== 'all' && city !== 'Cundinamarca' && city !== 'Todas') {
            query = query.ilike('city', `%${city}%`);
        }

        const { data, error } = await query.order('scouted_at', { ascending: false }).limit(25);

        if (error) {
            logger.error('Error querying local scouted projects:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        logger.error('Exception in searchLocalScoutedProjects:', err.message);
        return [];
    }
}

/**
 * Vacía por completo la tabla scouted_projects en Supabase
 */
export async function clearAllScoutedProjects() {
    try {
        logger.info('Vaciando tabla scouted_projects en Supabase...');
        const { error } = await supabaseAdmin
            .from('scouted_projects')
            .delete()
            .neq('id', '___non_existent_id___');

        if (error) {
            logger.error('Error clearing scouted_projects:', error);
            throw error;
        }

        logger.info('Tabla scouted_projects vaciada con éxito.');
        return { success: true, message: 'Todos los proyectos fueron eliminados exitosamente.' };
    } catch (err) {
        logger.error('Exception in clearAllScoutedProjects:', err.message);
        throw err;
    }
}

/**
 * Busca un proyecto específico por nombre:
 * 1. Primero en la base de datos Supabase
 * 2. Si no existe, lo rastrea en Google Serper en los sitios oficiales de constructoras y lo guarda
 */
export async function findProjectByName({ projectName, city = 'Bogotá' }) {
    if (!projectName || !projectName.trim()) {
        throw new Error('El nombre del proyecto es obligatorio');
    }
    const cleanName = projectName.trim();
    logger.info(`Searching for project by name: "${cleanName}" in city: ${city}`);

    // 1. Buscar primero en Supabase
    try {
        const { data: existing } = await supabaseAdmin
            .from('scouted_projects')
            .select('*')
            .ilike('name', `%${cleanName}%`)
            .limit(6);

        if (existing && existing.length > 0) {
            logger.info(`Found ${existing.length} existing projects matching "${cleanName}" in Supabase.`);
            return existing;
        }
    } catch (err) {
        logger.warn(`Supabase lookup error for "${cleanName}": ${err.message}`);
    }

    // 2. Si no está en Supabase, rastrear en las páginas oficiales de constructoras vía Serper
    if (!process.env.SERPER_API_KEY) {
        throw new Error('API key de búsqueda web no disponible');
    }

    const q = `"${cleanName}" (site:amarilo.com.co OR site:constructorabolivar.com OR site:cusezar.com OR site:constructoracapital.com OR site:galias.com.co OR site:marval.com.co OR site:prodesa.com OR site:arquitecturayconcreto.com)`;
    const serperResp = await axios.post(
        'https://google.serper.dev/search',
        { q, gl: 'co', hl: 'es', num: 6 },
        {
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 6000
        }
    );

    const organic = serperResp.data?.organic || [];
    const validCandidate = organic.find(it => it.link && ALLOWED_BUILDER_DOMAINS.some(d => it.link.includes(d)));

    if (!validCandidate) {
        logger.info(`No official builder page found online for "${cleanName}".`);
        return [];
    }

    // 3. Evaluar la página oficial del proyecto
    const evaluated = await evaluateOfficialProject({
        candidate: {
            url: validCandidate.link.split('?')[0].trim(),
            title: validCandidate.title || cleanName,
            snippet: validCandidate.snippet || ''
        },
        city: city || 'Bogotá',
        year: null,
        semester: 'direct_search'
    });

    if (!evaluated) {
        return [];
    }

    // 4. Generar análisis comercial MAS.3
    try {
        const aiInsight = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Eres el estratega comercial de arquitectura de MAS.3 en Bogotá y Cundinamarca. Resume en 2 párrafos concisos la oportunidad de negocio para contactar a este proyecto y ofrecer paquetes de acabados/remodelación antes de su entrega.'
                },
                {
                    role: 'user',
                    content: `Proyecto localizado: ${evaluated.name} (${evaluated.builder}, ${evaluated.city} - ${evaluated.zone}, Estrato ${evaluated.stratum})`
                }
            ],
            max_tokens: 280,
            temperature: 0.4
        });
        evaluated.commercial_insight = aiInsight.choices[0]?.message?.content?.trim();
    } catch (e) {
        logger.warn(`Could not generate insight for ${evaluated.name}: ${e.message}`);
    }

    // 5. Guardar en Supabase
    try {
        await supabaseAdmin.from('scouted_projects').upsert([evaluated]);
        logger.info(`Successfully stored single searched project "${evaluated.name}" in Supabase.`);
    } catch (dbErr) {
        logger.error(`Error saving project "${evaluated.name}" to Supabase:`, dbErr);
    }

    return [evaluated];
}

/**
 * Obtiene proyectos almacenados en Supabase, opcionalmente filtrados por año, semestre, ciudad y búsqueda
 */
export async function getScoutedProjectsHistory({ city, year, semester, month, search } = {}) {
    try {
        let query = supabaseAdmin
            .from('scouted_projects')
            .select('*');

        if (city && city !== 'all' && city !== 'Cundinamarca' && city !== 'Todas') {
            query = query.ilike('city', `%${city}%`);
        }
        if (year) {
            query = query.eq('delivery_year', String(year));
        }
        if (search && search.trim()) {
            query = query.ilike('name', `%${search.trim()}%`);
        }
        if (month) {
            query = query.eq('delivery_month', String(month));
        }

        const { data, error } = await query.order('scouted_at', { ascending: false });

        if (error) {
            logger.error('Error reading from Supabase scouted_projects:', error);
            return [];
        }

        let results = data || [];

        // Filtro en memoria por semestre para compatibilidad total con formatos semestrales y de meses
        if (semester && semester !== 'all') {
            results = results.filter(p => {
                const dateUpper = (p.delivery_date || '').toUpperCase();
                const m = p.delivery_month;
                if (semester === '1') {
                    if (dateUpper.includes('SEGUNDO SEMESTRE') && !dateUpper.includes('PRIMER SEMESTRE')) return false;
                    if (m && ['07', '08', '09', '10', '11', '12', 'S2'].includes(m)) return false;
                    return true;
                } else if (semester === '2') {
                    if (dateUpper.includes('PRIMER SEMESTRE') && !dateUpper.includes('SEGUNDO SEMESTRE')) return false;
                    if (m && ['01', '02', '03', '04', '05', '06', 'S1'].includes(m)) return false;
                    return true;
                }
                return true;
            });
        }

        return results;
    } catch (err) {
        logger.error('Supabase query error:', err.message);
        return [];
    }
}

/**
 * Elimina o descarta un proyecto de Supabase
 */
export async function deleteScoutedProject(id) {
    try {
        const { error } = await supabaseAdmin
            .from('scouted_projects')
            .delete()
            .eq('id', id);

        if (error) {
            logger.error('Error deleting project from Supabase:', error);
            throw error;
        }

        return { success: true };
    } catch (err) {
        logger.error('Error in deleteScoutedProject:', err.message);
        throw err;
    }
}

