import { google } from "googleapis";
import path from "path";
import { logger } from "../middleware/logger.js";

// Ruta al archivo de credenciales de Google 
const CREDENTIALS_PATH = path.resolve(process.cwd(), "google-credentials.json");

// Define los scopes necesarios para Google Calendar (incluyendo freebusy y gestión)
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// Inicializa el cliente de autenticación
const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
});

export const calendarService = {
    /**
     * Consulta la disponibilidad (Free/Busy) en el calendario especificado
     * @param {Object} calendar - Cliente de Google Calendar API
     * @param {string} calendarId - ID o correo del calendario
     * @param {Date} startDate - Fecha/Hora inicial
     * @param {Date} endDate - Fecha/Hora final
     * @returns {Promise<boolean>} True si el espacio está libre, False si está ocupado
     */
    async verificarDisponibilidad(calendar, calendarId, startDate, endDate) {
        try {
            const freeBusyResponse = await calendar.freebusy.query({
                requestBody: {
                    timeMin: startDate.toISOString(),
                    timeMax: endDate.toISOString(),
                    timeZone: "America/Bogota",
                    items: [{ id: calendarId }]
                }
            });

            const calendarBusyList = freeBusyResponse.data.calendars[calendarId]?.busy || [];
            return calendarBusyList.length === 0;
        } catch (error) {
            logger.warn("No se pudo verificar la disponibilidad en Google Calendar, procediendo con agendamiento directo", {
                error: error.message
            });
            return true;
        }
    },

    /**
     * Agenda una reunión en Google Calendar
     * @param {string} nombreCliente - El nombre del cliente para el evento
     * @param {string} fechaHoraIso - Fecha y hora en formato ISO 8601
     * @param {Object} [options] - Opciones adicionales (emailCliente, telefonoCliente, duracionHoras)
     * @returns {Promise<{success: boolean, message: string, isOccupied?: boolean, eventLink?: string, meetLink?: string}>}
     */
    async agendarReunionGoogle(nombreCliente, fechaHoraIso, options = {}) {
        try {
            const { emailCliente, telefonoCliente, duracionHoras = 1 } = options;
            const calendarId = process.env.GOOGLE_CALENDAR_ID || "danielmoyemanizales@gmail.com";

            // Inicializar el cliente de la API de Calendar
            const calendar = google.calendar({ version: "v3", auth });

            const startDate = new Date(fechaHoraIso);
            if (isNaN(startDate.getTime())) {
                return {
                    success: false,
                    message: "La fecha u hora proporcionada no tiene un formato ISO 8601 válido."
                };
            }

            // Calcular hora de fin según duracionHoras
            const endDate = new Date(startDate.getTime() + duracionHoras * 60 * 60 * 1000);

            // Verificar si el horario seleccionado está libre
            const estaLibre = await this.verificarDisponibilidad(calendar, calendarId, startDate, endDate);
            if (!estaLibre) {
                logger.info("Intento de agendamiento en horario ocupado", { calendarId, fechaHoraIso });
                return {
                    success: false,
                    isOccupied: true,
                    message: "El horario seleccionado ya se encuentra ocupado en la agenda. Por favor propone otra hora o fecha al cliente."
                };
            }

            // Construir la descripción del evento con los datos completos del cliente
            let description = `Reunión agendada automáticamente por el asistente de IA MAS3 para ${nombreCliente}.`;
            if (emailCliente) description += `\n✉️ Correo electrónico: ${emailCliente}`;
            if (telefonoCliente) description += `\n📱 Teléfono de contacto: ${telefonoCliente}`;

            // Formato base del evento (se omiten attendees directos para evitar restricciones de Service Account en calendarios personales @gmail.com)
            const eventBody = {
                summary: `Reunión: Asesoría Mas3 - ${nombreCliente}`,
                description,
                start: {
                    dateTime: startDate.toISOString(),
                    timeZone: "America/Bogota",
                },
                end: {
                    dateTime: endDate.toISOString(),
                    timeZone: "America/Bogota",
                }
            };

            // Usar el enlace de videollamada oficial de Google Meet configurado (o el definido en .env)
            const meetLink = process.env.GOOGLE_MEET_LINK || "https://meet.google.com/mas-asesoria-mas3";

            // Incluir el enlace de Google Meet en la descripción del evento de Google Calendar
            eventBody.description += `\n💻 Enlace de videollamada (Google Meet): ${meetLink}`;

            // Insertar evento en Google Calendar con la descripción completa
            const response = await calendar.events.insert({
                calendarId,
                requestBody: eventBody
            });



            const eventLink = response.data.htmlLink;

            logger.info("Google Calendar event created successfully with Google Meet", {
                eventId: response.data.id,
                meetLink,
                eventLink
            });

            return {
                success: true,
                message: "Reunión agendada exitosamente en Google Calendar.",
                eventLink,
                meetLink
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
