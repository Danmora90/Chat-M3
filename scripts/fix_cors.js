import admin from "firebase-admin";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuración para leer .env desde la raíz
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function configureCors() {
    console.log('🔧 Configurando CORS para Firebase Storage...');

    try {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            throw new Error("Falta FIREBASE_SERVICE_ACCOUNT_JSON en el archivo .env");
        }
        
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            });
        }

        const bucket = admin.storage().bucket();
        console.log(`📦 Bucket detectado: ${bucket.name}`);

        await bucket.setCorsConfiguration([
            {
                origin: ["http://localhost:5173", "http://localhost:3000", "http://localhost:3001", "*"],
                method: ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"],
                responseHeader: ["Content-Type", "Authorization", "Content-Length", "User-Agent", "x-goog-resumable"],
                maxAgeSeconds: 3600
            }
        ]);

        console.log("✅ ¡Éxito! CORS configurado correctamente. Ahora el frontend podrá descargar archivos.");
    } catch (error) {
        console.error("❌ Error configurando CORS:", error);
    }
}

configureCors();
