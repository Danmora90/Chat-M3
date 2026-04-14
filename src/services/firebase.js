import admin from "firebase-admin";

// Inicializar solo si no existe ya una instancia
if (!admin.apps.length) {
    try {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing in environment variables");
        }

        if (!process.env.FIREBASE_STORAGE_BUCKET) {
            throw new Error("FIREBASE_STORAGE_BUCKET is missing in environment variables");
        }

        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        });

        console.log("Firebase Admin initialized successfully");
    } catch (error) {
        console.error("Firebase initialization error:", error);
    }
}

// Exportar el bucket de almacenamiento
// Nota: Si la inicialización falló, esto podría lanzar error al usarse.
export const bucket = admin.storage().bucket();

/**
 * Sube un archivo a Firebase Storage
 * @param {Buffer} buffer - El archivo en buffer
 * @param {string} destination - Ruta destino en el bucket (ej: chats/123/img.jpg)
 * @param {string} mimeType - Tipo MIME del archivo
 * @returns {Promise<string>} La ruta de almacenamiento
 */
export async function uploadFile(buffer, destination, mimeType) {
    const file = bucket.file(destination);

    await file.save(buffer, {
        metadata: {
            contentType: mimeType,
        }
    });

    return destination;
}

/**
 * Genera una URL firmada para acceso temporal
 * @param {string} storagePath - La ruta del archivo en Storage
 * @param {number} expiresInDays - Días de validez (default 7)
 * @returns {Promise<Object>} { signedUrl, expiresAt }
 */
export async function getSignedUrl(storagePath, expiresInDays = 7) {
    const file = bucket.file(storagePath);

    // Calcular fecha de expiración
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const [url] = await file.getSignedUrl({
        action: 'read',
        expires: expiresAt,
        version: 'v4'
    });

    return {
        signedUrl: url,
        expiresAt: expiresAt.toISOString()
    };
}
