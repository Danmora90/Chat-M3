import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import path from 'path';
import { supabaseAdmin } from '../src/services/supabase.js';
import { qualifyCommentsAndGenerateDMs } from '../src/services/aiProspecting.js';
import { logger } from '../src/middleware/logger.js';

const SESSION_DIR = process.env.IG_BURNER_SESSION_DIR || path.resolve(process.cwd(), '.ig-burner-session');
const MAX_COMPANIES_PER_RUN = 5;
const MAX_LEADS_PER_COMPANY = 2;
const MAX_GLOBAL_LEADS_PER_RUN = 10;

// Palabras clave semilla para descubrimiento si hay pocas empresas en la BD
const SEED_KEYWORDS = [
    'remodelaciones bogota',
    'diseño interior colombia',
    'remodelacion apartamentos',
    'arquitectura de interiores colombia'
];

/**
 * Espera con jitter aleatorio para simular comportamiento humano (entre min y max ms)
 */
function randomSleep(min = 6000, max = 15000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(`⏳ Espera humana de seguridad: ${(delay / 1000).toFixed(1)} segundos...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Fase 1: Obtener empresas activas o descubrir nuevas por keywords
 */
async function getOrDiscoverTargetCompanies(page) {
    console.log('\n🔍 [Fase 1] Consultando empresas objetivo en Supabase...');

    let { data: companies, error } = await supabaseAdmin
        .from('ig_target_companies')
        .select('*')
        .eq('is_active', true)
        .order('last_scraped_at', { ascending: true, nullsFirst: true })
        .limit(MAX_COMPANIES_PER_RUN);

    if (error) {
        console.error('Error al consultar ig_target_companies:', error);
        throw error;
    }

    companies = companies || [];
    console.log(`📋 Se encontraron ${companies.length} empresa(s) activa(s) registrada(s).`);

    // Si no hay ninguna empresa activa registrada, descubrir nuevas mediante búsqueda en Instagram
    if (companies.length === 0) {
        console.log(`⚡ No hay empresas activas en la BD. Descubriendo ${MAX_COMPANIES_PER_RUN} cuentas iniciales...`);

        const randomKeyword = SEED_KEYWORDS[Math.floor(Math.random() * SEED_KEYWORDS.length)];
        console.log(`🔎 Buscando cuentas con la palabra clave: "${randomKeyword}"`);

        const discovered = await discoverCompaniesByKeyword(page, randomKeyword, MAX_COMPANIES_PER_RUN);
        for (const item of discovered) {
            try {
                const { data: inserted, error: insErr } = await supabaseAdmin
                    .from('ig_target_companies')
                    .insert({
                        username: item.username,
                        profile_url: item.profile_url,
                        search_keyword: randomKeyword,
                        is_active: true
                    })
                    .select()
                    .single();

                if (!insErr && inserted) {
                    console.log(`➕ Nueva empresa guardada: @${inserted.username}`);
                    companies.push(inserted);
                }
            } catch (dupErr) {
                // Posible duplicado ya existente
            }
        }
    }

    return companies.slice(0, MAX_COMPANIES_PER_RUN);
}

/**
 * Descubre cuentas en Instagram mediante el buscador e intercepción de red
 */
async function discoverCompaniesByKeyword(page, keyword, maxToFind = 3) {
    const discovered = [];
    try {
        const searchUrl = `https://www.instagram.com/explore/search/`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(3000, 5000);

        // Selector común del input de búsqueda
        const searchInput = page.locator('input[placeholder*="Buscar"], input[placeholder*="Search"]').first();
        if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await searchInput.fill(keyword);
            await randomSleep(2000, 4000);

            // Capturar enlaces a perfiles en el dropdown de resultados
            const links = await page.locator('a[href^="/"][role="link"]').all();
            for (const link of links) {
                if (discovered.length >= maxToFind) break;
                const href = await link.getAttribute('href');
                if (!href) continue;

                // Extraer username omitiendo rutas internas de explore/direct
                const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
                if (match) {
                    const uname = match[1].toLowerCase();
                    if (!['explore', 'direct', 'reels', 'stories', 'p'].includes(uname)) {
                        if (!discovered.some(d => d.username === uname)) {
                            discovered.push({
                                username: uname,
                                profile_url: `https://www.instagram.com/${uname}/`
                            });
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Advertencia en descubrimiento automático de perfiles:', err.message);
    }
    return discovered;
}

/**
 * Fase 2: Extraer 2 o 3 publicaciones o Reels más recientes de un perfil
 */
async function fetchRecentPostUrls(page, username) {
    console.log(`\n📸 [Fase 2] Extrayendo publicaciones recientes de @${username}...`);
    const profileUrl = `https://www.instagram.com/${username}/`;

    try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(4000, 7000);

        // Extraer enlaces a posts (/p/ o /reel/)
        const postUrls = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
            const urls = [];
            for (const a of anchors) {
                // Verificar si tiene indicador de fijado/pinned
                const isPinned = a.querySelector('svg[aria-label="Fijado"], svg[aria-label="Pinned"]');
                if (isPinned) continue; // Ignorar fijados antiguos

                const href = a.getAttribute('href') || '';
                const match = href.match(/\/(p|reel)\/([a-zA-Z0-9_-]+)/);
                if (match) {
                    const cleanUrl = `https://www.instagram.com/${match[1]}/${match[2]}/`;
                    if (!urls.includes(cleanUrl)) {
                        urls.push(cleanUrl);
                    }
                }
                if (urls.length >= 5) break;
            }
            return urls;
        });

        console.log(`📌 Encontradas ${postUrls.length} publicaciones recientes para @${username}.`);
        return postUrls;

    } catch (err) {
        console.error(`Error al acceder al perfil @${username}:`, err.message);
        return [];
    }
}

/**
 * Extractor recursivo universal para comentarios en respuestas JSON de Instagram
 */
function extractCommentsFromJson(json, companyUsername) {
    const comments = [];
    if (!json || typeof json !== 'object') return comments;

    function recurse(obj) {
        if (!obj || typeof obj !== 'object') return;

        // Comprobar si el objeto actual tiene estructura de comentario: texto y usuario
        const text = obj.text || obj.comment_text;
        const userObj = obj.user || obj.owner;
        const username = userObj?.username;
        const fullName = userObj?.full_name || '';

        if (typeof text === 'string' && typeof username === 'string') {
            const cleanUser = username.toLowerCase().trim();
            const cleanText = text.trim();
            if (cleanUser && cleanText && cleanUser !== companyUsername.toLowerCase()) {
                if (!comments.some(c => c.username === cleanUser && c.comment_text === cleanText)) {
                    comments.push({
                        username: cleanUser,
                        full_name: fullName,
                        comment_text: cleanText
                    });
                }
            }
        }

        if (Array.isArray(obj)) {
            for (const item of obj) recurse(item);
        } else {
            for (const key of Object.keys(obj)) {
                recurse(obj[key]);
            }
        }
    }

    recurse(json);
    return comments;
}

/**
 * Fase 3: Captura de comentarios mediante intercepción de red y selectores DOM
 */
async function capturePostComments(page, postUrl, companyUsername) {
    console.log(`\n💬 [Fase 3] Analizando comentarios en: ${postUrl}`);
    const interceptedComments = [];

    // Listener de intercepción de respuestas JSON de Instagram (GraphQL / API v1)
    const responseListener = async (response) => {
        try {
            const url = response.url();
            if (url.includes('graphql') || url.includes('/api/v1/media/') || url.includes('/comments/')) {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const json = await response.json().catch(() => null);
                    if (!json) return;

                    const found = extractCommentsFromJson(json, companyUsername);
                    for (const c of found) {
                        if (!interceptedComments.some(ic => ic.username === c.username && ic.comment_text === c.comment_text)) {
                            interceptedComments.push(c);
                        }
                    }
                }
            }
        } catch {
            // Ignorar errores en respuestas secundarias
        }
    };

    page.on('response', responseListener);

    try {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await randomSleep(4000, 6000);

        // En Instagram Reels y publicaciones, el drawer de comentarios debe ser abierto si está cerrado
        const commentBtn = page.locator('svg[aria-label="Comentario"], svg[aria-label="Comentar"], svg[aria-label="Comment"], svg[aria-label="Comentarios"], [aria-label="Comentario"], [aria-label="Comentar"]').first();
        if (await commentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('👆 Abriendo panel de comentarios...');
            await commentBtn.click({ force: true }).catch(() => {});
            await randomSleep(2500, 4000);
        }

        // Desplazar dentro del diálogo de comentarios para detonar carga adicional
        const dialogContainer = page.locator('div[role="dialog"]').first();
        if (await dialogContainer.isVisible({ timeout: 1000 }).catch(() => false)) {
            await dialogContainer.evaluate(el => el.scrollBy(0, 300)).catch(() => {});
        } else {
            await page.mouse.wheel(0, 200).catch(() => {});
        }
        await randomSleep(1500, 2500);

        // Fallback DOM si la intercepción de red capturó pocos comentarios
        if (interceptedComments.length < 5) {
            const domComments = await page.evaluate((compUsername) => {
                const results = [];
                const dialog = document.querySelector('div[role="dialog"]') || document;
                const commentLinks = Array.from(dialog.querySelectorAll('a[href*="/c/"]'));

                // Extracción moderna por enlaces de comentarios individuales
                for (const cl of commentLinks) {
                    let row = cl;
                    while (row && row.parentElement && !row.innerText.includes('Responder') && row !== dialog) {
                        row = row.parentElement;
                    }
                    if (!row) continue;

                    const authorLink = row.querySelector('a[href^="/"][role="link"]:not([href*="/c/"]):not([href*="/p/"])');
                    const username = authorLink?.innerText?.trim()?.toLowerCase();
                    if (!username || username === compUsername.toLowerCase() || username.includes(' ')) continue;

                    const leafSpans = Array.from(row.querySelectorAll('span')).filter(s => s.children.length === 0);
                    let commentText = '';
                    for (const span of leafSpans) {
                        const txt = span.innerText?.trim();
                        if (!txt) continue;
                        if (txt.toLowerCase() === username) continue;
                        if (txt.match(/^\d+\s*(s|m|min|h|d|sem|w)$/i)) continue;
                        if (['responder', 'reply', 'me gusta', 'like', 'ver traducción', 'ver las', 'ocultar'].some(ignore => txt.toLowerCase().startsWith(ignore))) continue;

                        commentText = txt;
                        break;
                    }

                    if (commentText && !results.some(r => r.username === username)) {
                        results.push({
                            username,
                            full_name: '',
                            comment_text: commentText
                        });
                    }
                }

                // Fallback tradicional para vistas clásicas con elementos li
                if (results.length === 0) {
                    const items = Array.from(document.querySelectorAll('ul > div > li, ul > li, div[role="dialog"] ul li'));
                    for (const li of items) {
                        const userLink = li.querySelector('a[role="link"], h3 a');
                        const textSpan = li.querySelector('span[dir="auto"], div[dir="auto"]');
                        const uname = userLink?.innerText?.trim()?.toLowerCase();
                        const text = textSpan?.innerText?.trim();

                        if (uname && text && uname !== compUsername.toLowerCase() && text.length >= 2) {
                            if (!results.some(r => r.username === uname)) {
                                results.push({
                                    username: uname,
                                    full_name: '',
                                    comment_text: text
                                });
                            }
                        }
                    }
                }

                return results;
            }, companyUsername);

            for (const dc of domComments) {
                if (!interceptedComments.some(ic => ic.username === dc.username)) {
                    interceptedComments.push(dc);
                }
            }
        }

    } catch (err) {
        console.warn(`Error al cargar comentarios en ${postUrl}:`, err.message);
    } finally {
        page.off('response', responseListener);
    }

    // Deduplicar en memoria
    const unique = [];
    const seen = new Set();
    for (const c of interceptedComments) {
        if (!seen.has(c.username)) {
            seen.add(c.username);
            unique.push(c);
        }
        if (unique.length >= 20) break;
    }

    console.log(`📥 Total comentarios recolectados: ${unique.length}`);
    return unique;
}

/**
 * Verifica con precisión si el navegador tiene una sesión activa y autenticada en Instagram.
 */
async function isSessionActive(context, page) {
    try {
        if (page.isClosed()) return false;

        // 1. Si los campos de login (password/email) están en pantalla, NO está autenticado
        const hasPasswordField = await page.locator('input[type="password"], input[name="pass"], input[name="password"]').first().isVisible().catch(() => false);
        if (hasPasswordField) {
            return false;
        }

        // 2. Revisar cookies de autenticación de Instagram
        const cookies = await context.cookies('https://www.instagram.com');
        const hasSessionCookie = cookies.some(c => 
            (c.name === 'sessionid' || c.name === 'ds_user_id') && c.value && c.value.length > 3
        );

        // 3. Revisar elementos exclusivos de usuario logueado en la interfaz
        // NOTA: Jamás incluir a[href*="/explore/"] porque el footer público contiene "/explore/locations/"
        const hasNavFeed = await page.locator(
            'svg[aria-label="Inicio"], svg[aria-label="Home"], svg[aria-label="Mensajes"], svg[aria-label="Direct"], a[href*="/direct/inbox/"]'
        ).first().isVisible().catch(() => false);

        return hasSessionCookie || hasNavFeed;
    } catch {
        return false;
    }
}

/**
 * Asegura que exista una sesión activa en Instagram antes de raspar.
 * Mantiene la ventana abierta de forma visible para que el usuario ingrese sus datos.
 * Tan pronto como detecta el login exitoso, continúa automáticamente con el scraping.
 */
async function ensureAuthenticatedSession(context, page) {
    console.log('\n🔍 Verificando estado de la sesión en Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const alreadyAuth = await isSessionActive(context, page);
    if (alreadyAuth) {
        console.log('✅ Sesión de cuenta señuelo activa y verificada.');
        return true;
    }

    console.log('\n======================================================');
    console.log('  🟡 ESPERANDO INICIO DE SESIÓN EN PLAYWRIGHT');
    console.log('======================================================');
    console.log('👉 La ventana de Chromium está abierta en tu pantalla.');
    console.log('👉 Ingresa tu usuario y contraseña de la cuenta secundaria / señuelo.');
    console.log('👉 La ventana permanecerá abierta esperando tu login.');
    console.log('👉 En cuanto inicies sesión, el scraping arrancará AUTOMÁTICAMENTE.');
    console.log('======================================================\n');

    await page.bringToFront().catch(() => {});

    const timeoutMs = 600000; // 10 minutos de margen para el usuario
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        if (page.isClosed()) {
            throw new Error('La ventana de Chromium fue cerrada manualmente por el usuario.');
        }

        const authenticated = await isSessionActive(context, page);
        if (authenticated) {
            console.log('\n🎉 ¡Login exitoso detectado en Playwright!');
            console.log('💾 Guardando cookies de sesión en el perfil persistente...');
            await page.waitForTimeout(4000);
            console.log('🚀 Iniciando scraping de prospección automáticamente...\n');
            return true;
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error('Tiempo de espera agotado (10 minutos) sin iniciar sesión en Instagram.');
}

/**
 * Función principal del Scraper
 */
export async function runInstagramScraper() {
    console.log('\n======================================================');
    console.log('   MAS.3 - MOTOR AUTÓNOMO DE PROSPECCIÓN EN INSTAGRAM');
    console.log('======================================================');
    console.log(`📁 Directorio de sesión: ${SESSION_DIR}`);
    console.log(`🎯 Meta de extracción: Máximo ${MAX_LEADS_PER_COMPANY} leads/empresa | Tope total: ${MAX_GLOBAL_LEADS_PER_RUN} leads`);

    const isHeadless = process.env.IG_HEADLESS === 'true';

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: isHeadless,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        locale: 'es-ES',
        timezoneId: 'America/Bogota',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    let totalExtractedLeads = 0;
    const sessionSummary = [];

    try {
        // Asegurar que el usuario esté logueado antes de iniciar el scraping
        await ensureAuthenticatedSession(context, page);

        // Fase 1: Empresas objetivo
        const companies = await getOrDiscoverTargetCompanies(page);
        if (companies.length === 0) {
            console.log('\n⚠️ No hay empresas objetivo activas en Supabase (ig_target_companies) ni se pudieron descubrir nuevas.');
            console.log('👉 Tip: Agrega al menos 1 o 2 cuentas competidoras en la pestaña "Empresas Fuente" del panel web.');
            return { totalLeads: 0, summary: [] };
        }

        console.log(`\n🚀 Iniciando procesamiento secuencial de ${companies.length} empresas...`);

        for (const company of companies) {
            if (totalExtractedLeads >= MAX_GLOBAL_LEADS_PER_RUN) {
                console.log(`🛑 Se alcanzó el límite global diario de ${MAX_GLOBAL_LEADS_PER_RUN} prospectos calificados.`);
                break;
            }

            console.log(`\n🏢 [Empresa] @${company.username} (${company.profile_url})`);
            let leadsFromThisCompany = 0;

            // Fase 2: Posts recientes
            const postUrls = await fetchRecentPostUrls(page, company.username);
            if (postUrls.length === 0) {
                console.log(`⚠️ No se obtuvieron publicaciones recientes para @${company.username}. Pasando a la siguiente.`);
                continue;
            }

            for (const postUrl of postUrls) {
                if (leadsFromThisCompany >= MAX_LEADS_PER_COMPANY) {
                    console.log(`✅ Límite de ${MAX_LEADS_PER_COMPANY} prospectos alcanzado para @${company.username}.`);
                    break;
                }
                if (totalExtractedLeads >= MAX_GLOBAL_LEADS_PER_RUN) break;

                // Fase 3: Captura de comentarios
                const comments = await capturePostComments(page, postUrl, company.username);
                if (comments.length === 0) {
                    console.log('ℹ️ No hay comentarios nuevos en esta publicación.');
                    continue;
                }

                // Filtrar en memoria usuarios que ya existan en Supabase (Deduplicación estricta)
                const candidateUsernames = comments.map(c => c.username);
                const { data: existingLeads, error: dupCheckErr } = await supabaseAdmin
                    .from('ig_extracted_leads')
                    .select('username')
                    .in('username', candidateUsernames);

                if (dupCheckErr) {
                    console.warn('Advertencia al consultar duplicados en Supabase:', dupCheckErr.message);
                }

                const existingSet = new Set((existingLeads || []).map(l => l.username.toLowerCase()));
                const freshComments = comments.filter(c => !existingSet.has(c.username.toLowerCase()));

                console.log(`✨ Comentarios no procesados previamente: ${freshComments.length} de ${comments.length}`);
                if (freshComments.length === 0) {
                    console.log('ℹ️ Todos los comentaristas de este post ya fueron extraídos anteriormente.');
                    continue;
                }

                // Enviar a OpenAI para Calificación & Redacción de DM
                console.log('🤖 Enviando comentarios a OpenAI API para calificación y generación de DM...');
                let qualifiedLeads = [];
                try {
                    qualifiedLeads = await qualifyCommentsAndGenerateDMs(freshComments, {
                        postUrl,
                        companyUsername: company.username
                    });
                } catch (aiErr) {
                    console.error('❌ Error en calificación con OpenAI:', aiErr.message);
                    continue;
                }

                if (qualifiedLeads.length === 0) {
                    console.log('ℹ️ OpenAI no encontró prospectos con intención real de compra en este lote.');
                    continue;
                }

                // Guardar prospectos calificados en Supabase
                for (const lead of qualifiedLeads) {
                    if (leadsFromThisCompany >= MAX_LEADS_PER_COMPANY) break;
                    if (totalExtractedLeads >= MAX_GLOBAL_LEADS_PER_RUN) break;

                    const originalCommentObj = freshComments.find(fc => fc.username.toLowerCase() === lead.username.toLowerCase());
                    const commentText = originalCommentObj?.comment_text || '';
                    const fullName = originalCommentObj?.full_name || '';

                    try {
                        const { data: insertedLead, error: leadInsErr } = await supabaseAdmin
                            .from('ig_extracted_leads')
                            .insert({
                                company_id: company.id,
                                username: lead.username,
                                full_name: fullName,
                                profile_url: `https://www.instagram.com/${lead.username}/`,
                                source_post_url: postUrl,
                                comment_text: commentText,
                                ai_intent_score: lead.ai_intent_score,
                                suggested_dm: lead.suggested_dm,
                                status: 'pendiente',
                                extracted_at: new Date().toISOString()
                            })
                            .select()
                            .single();

                        if (leadInsErr) {
                            if (leadInsErr.code === '23505') {
                                console.log(`⏩ Usuario @${lead.username} ya estaba en la base de datos (saltado).`);
                            } else {
                                console.error(`Error guardando lead @${lead.username}:`, leadInsErr.message);
                            }
                        } else if (insertedLead) {
                            leadsFromThisCompany++;
                            totalExtractedLeads++;
                            console.log(`\n🎉 [PROSPECTO EXTRAÍDO #${totalExtractedLeads}]`);
                            console.log(`   👤 Usuario: @${insertedLead.username} (${insertedLead.full_name || 'Sin nombre'})`);
                            console.log(`   💬 Comentario: "${insertedLead.comment_text}"`);
                            console.log(`   🎯 Intención IA: ${insertedLead.ai_intent_score}`);
                            console.log(`   ✍️ DM Sugerido: "${insertedLead.suggested_dm}"`);
                            sessionSummary.push(insertedLead);
                        }
                    } catch (insEx) {
                        console.error('Excepción al insertar lead:', insEx);
                    }
                }
            }

            // Actualizar last_scraped_at de la empresa procesada
            await supabaseAdmin
                .from('ig_target_companies')
                .update({ last_scraped_at: new Date().toISOString() })
                .eq('id', company.id);

            // Jitter de pausa antes de la siguiente empresa
            await randomSleep(8000, 15000);
        }

    } catch (err) {
        console.error('❌ Error crítico en el ciclo de prospección:', err);
    } finally {
        await context.close().catch(() => {});
        console.log('\n======================================================');
        console.log('           RESUMEN FINAL DE LA CORRIDA');
        console.log('======================================================');
        console.log(`✅ Total de prospectos calificados extraídos hoy: ${totalExtractedLeads}`);
        console.log(`💾 Los registros están disponibles en Supabase (ig_extracted_leads)`);
        console.log('   y listos en el dashboard para contactar en 1 clic.\n');
    }

    return {
        totalLeads: totalExtractedLeads,
        summary: sessionSummary
    };
}

// Ejecución directa por CLI (`npm run ig:scrape`)
if (process.argv[1] && process.argv[1].endsWith('ig_scraper.js')) {
    runInstagramScraper().then(() => {
        process.exit(0);
    }).catch(err => {
        console.error('Fallo en la ejecución:', err);
        process.exit(1);
    });
}
