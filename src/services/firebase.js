import admin from "firebase-admin";

// Inicializar solo si existe configuración válida en el entorno
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON && process.env.FIREBASE_STORAGE_BUCKET) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            if (typeof serviceAccount.private_key === 'string') {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            });

            console.log("Firebase Admin initialized successfully");
        }
    } catch (error) {
        console.warn("Firebase initialization warning:", error.message);
    }
}

export function getBucket() {
    if (!admin.apps.length) return null;
    try {
        return admin.storage().bucket();
    } catch (e) {
        return null;
    }
}

/**
 * Sube un archivo a Firebase Storage (si estuviera disponible)
 */
export async function uploadFile(buffer, destination, mimeType) {
    const bucket = getBucket();
    if (!bucket) throw new Error("Firebase storage bucket not available");
    const file = bucket.file(destination);

    await file.save(buffer, {
        metadata: {
            contentType: mimeType,
        }
    });

    return destination;
}

/**
 * Genera una URL firmada para acceso temporal en Firebase
 */
export async function getSignedUrl(storagePath, expiresInDays = 7) {
    const bucket = getBucket();
    if (!bucket) throw new Error("Firebase storage bucket not available");
    const file = bucket.file(storagePath);

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
