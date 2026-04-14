/**
 * Utilidades para manejo de sesiones
 * Las sesiones se identifican por número de teléfono
 */

/**
 * Extrae el número de teléfono limpio del formato de Twilio
 * @param {string} twilioNumber - Número en formato Twilio (whatsapp:+1234567890)
 * @returns {string} Número limpio (+1234567890)
 */
export function extractPhoneNumber(twilioNumber) {
    if (!twilioNumber) return null;
    return twilioNumber.replace('whatsapp:', '');
}

/**
 * Formatea un número de teléfono para uso con Twilio
 * @param {string} phoneNumber - Número de teléfono limpio
 * @returns {string} Número formateado para Twilio
 */
export function formatForTwilio(phoneNumber) {
    if (!phoneNumber) return null;
    if (phoneNumber.startsWith('whatsapp:')) return phoneNumber;
    return `whatsapp:${phoneNumber}`;
}

/**
 * Valida formato de número de teléfono
 * @param {string} phoneNumber - Número a validar
 * @returns {boolean} True si el formato es válido
 */
export function isValidPhoneNumber(phoneNumber) {
    if (!phoneNumber) return false;
    // Formato básico: +[código país][número]
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    const cleanNumber = extractPhoneNumber(phoneNumber);
    return phoneRegex.test(cleanNumber);
}

/**
 * Genera un ID de thread único para LangGraph
 * @param {string} chatId - ID del chat
 * @returns {string} Thread ID
 */
export function generateThreadId(chatId) {
    return `conversation_${chatId}`;
}
