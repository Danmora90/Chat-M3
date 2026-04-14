import { google } from "googleapis";
import path from "path";
import { logger } from "../middleware/logger.js";

// Ruta al archivo de credenciales de Google 
const CREDENTIALS_PATH = path.resolve(process.cwd(), "google-credentials.json");

// Define los scopes necesarios para Google Calendar
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// Inicializa el cliente de autenticación
const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
});

export const calendarService = {
    /**
     * Agenda una reunión en Google Calendar
     * @param {string} nombreCliente - El nombre del cliente para el evento
     * @param {string} fechaHoraIso - Fecha y hora en formato ISO 8601
     * @returns {Promise<{success: boolean, message: string, eventLink?: string}>}
     */
    async agendarReunionGoogle(nombreCliente, fechaHoraIso) {
        try {
            // Inicializar el cliente de la API de Calendar
            const calendar = google.calendar({ version: "v3", auth });

            // Calcular hora de fin (asumimos 1 hora de duración)
            const startDate = new Date(fechaHoraIso);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hora después

            // Formato de evento para la API
            const event = {
                summary: `Reunión: Asesoría Mas3 - ${nombreCliente}`,
                description: `Reunión agendada automáticamente por el asistente de IA para ${nombreCliente}.`,
                start: {
                    dateTime: startDate.toISOString(),
                    timeZone: "America/Bogota",
                },
                end: {
                    dateTime: endDate.toISOString(),
                    timeZone: "America/Bogota",
                },
            };

            // Insertar el evento en el calendario de danielmoyemanizales
            const response = await calendar.events.insert({
                calendarId: "danielmoyemanizales@gmail.com",
                requestBody: event,
            });

            logger.info("Google Calendar event created successfully", { eventId: response.data.id });

            return {
                success: true,
                message: "Reunión agendada exitosamente en Google Calendar.",
                eventLink: response.data.htmlLink
            };

        } catch (error) {
            logger.error("Error agendando reunión en Google Calendar:", error);
            return {
                success: false,
                message: `Error al intentar agendar la reunión: ${error.message}`
            };
        }
    }
};
