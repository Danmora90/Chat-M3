import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';

const SESSION_DIR = process.env.IG_BURNER_SESSION_DIR || path.resolve(process.cwd(), '.ig-burner-session');

async function main() {
    console.log('\n======================================================');
    console.log('  MAS.3 - INICIO DE SESIÓN DE CUENTA SEÑUELO INSTAGRAM');
    console.log('======================================================\n');
    console.log(`📁 Directorio de sesión aislada: ${SESSION_DIR}`);
    console.log('🚀 Abriendo navegador visible para autenticación manual...\n');

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
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

    console.log('🌐 Navegando a https://www.instagram.com/ ...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });

    console.log('\n------------------------------------------------------');
    console.log('  INSTRUCCIONES PARA EL OPERADOR:');
    console.log('  1. En la ventana que se abrió, ingresa el usuario y contraseña');
    console.log('     de la cuenta secundaria / señuelo (burner account).');
    console.log('  2. Resuelve códigos de seguridad o verificación si aparecen.');
    console.log('  3. Asegúrate de llegar al Feed principal de Instagram.');
    console.log('  4. Una vez autenticado, regresa a esta terminal y');
    console.log('     presiona la tecla [ENTER] para guardar las cookies y salir.');
    console.log('------------------------------------------------------\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    await new Promise((resolve) => {
        rl.question('👉 Presiona [ENTER] cuando hayas iniciado sesión con éxito: ', () => {
            rl.close();
            resolve();
        });
    });

    console.log('\n💾 Guardando estado de la sesión y cerrando navegador...');
    await context.close();
    console.log('✅ ¡Sesión guardada exitosamente en .ig-burner-session!');
    console.log('   Ya puedes ejecutar "npm run ig:scrape" para iniciar la prospección autónoma.\n');
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Error durante el inicio de sesión:', err);
    process.exit(1);
});
