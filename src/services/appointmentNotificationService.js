import { sendWhatsAppTemplate } from './twilio.js';
import { logger } from '../middleware/logger.js';

// Lista de números por defecto a notificar si no están en .env
const DEFAULT_RECIPIENTS = [
    '+573197595613',
    '+573114108754',
    '+573045438229',
    '+573128021306'
];

const DEFAULT_TEMPLATE_SID = 'HX9e5769c4b75c95b92447342884938f4b';

/**
 * Formatea una fecha y hora ISO a un formato legible en español (hora Colombia)
 * @param {string} fechaIso - Fecha en formato ISO 8601
 * @returns {string} Fecha y hora legible (ej: "Lunes, 28 de septiembre, 3:00 p. m.")
 */
function formatMeetingDate(fechaIso) {
    try {
        const date = new Date(fechaIso);
        if (isNaN(date.getTime())) {
            return fechaIso;
        }

        const formatter = new Intl.DateTimeFormat('es-CO', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'America/Bogota'
        });

        // Capitalizar la primera letra del día de la semana
        const formatted = formatter.format(date);
        return formatted.charAt(0).toUpperCase() + formatted.slice(1);
    } catch (e) {
        return fechaIso;
    }
}

/**
 * Notifica al equipo de asesores/administradores cuando un cliente agenda una reunión
 * @param {Object} params
 * @param {string} params.nombreCliente - Nombre del cliente
 * @param {string} params.telefonoCliente - Teléfono del cliente
 * @param {string} params.fechaHoraIso - Fecha y hora en formato ISO 8601
 * @param {string} [params.meetLink] - Enlace de Google Meet (opcional)
 * @param {string} [params.detalle] - Detalle del tema (opcional)
 */
export async function notifyAppointmentScheduled({
    nombreCliente,
    telefonoCliente,
    fechaHoraIso,
    meetLink = null,
    detalle = null
}) {
    try {
        const templateSid = process.env.APPOINTMENT_TEMPLATE_SID || DEFAULT_TEMPLATE_SID;

        // Obtener lista de números desde el .env o usar los valores por defecto
        const rawRecipients = process.env.APPOINTMENT_NOTIFICATION_NUMBERS;
        const recipients = rawRecipients
            ? rawRecipients.split(',').map(n => n.trim()).filter(Boolean)
            : DEFAULT_RECIPIENTS;

        const fechaFormateada = formatMeetingDate(fechaHoraIso);

        // Armar el detalle para la variable {{4}}
        let temaDetalle = detalle || 'Asesoría y Renovación MAS.3';
        if (meetLink) {
            temaDetalle += ` (Google Meet: ${meetLink})`;
        }

        // Variables mapeadas según la plantilla:
        // Cliente: {{1}}, Teléfono: {{2}}, Fecha y hora: {{3}}, Tema/Detalle: {{4}}
        const contentVariables = {
            "1": String(nombreCliente || 'Cliente').trim(),
            "2": String(telefonoCliente || 'No especificado').trim(),
            "3": String(fechaFormateada).trim(),
            "4": String(temaDetalle).trim()
        };

        logger.info('Iniciando notificación de agendamiento al equipo', {
            templateSid,
            recipientsCount: recipients.length,
            contentVariables
        });

        // Enviar a todos los números en paralelo usando Promise.allSettled
        const results = await Promise.allSettled(
            recipients.map(async (phone) => {
                const res = await sendWhatsAppTemplate(phone, templateSid, contentVariables);
                return { phone, sid: res.sid, status: res.status };
            })
        );

        let sentCount = 0;
        let errorCount = 0;

        results.forEach((res, index) => {
            const phone = recipients[index];
            if (res.status === 'fulfilled') {
                sentCount++;
                logger.info(`Notificación de agendamiento enviada a ${phone}`, { sid: res.value.sid });
            } else {
                errorCount++;
                logger.error(`Error enviando notificación de agendamiento a ${phone}:`, res.reason?.message || res.reason);
            }
        });

        logger.info('Resumen de notificaciones de agendamiento enviadas', {
            total: recipients.length,
            enviados: sentCount,
            errores: errorCount
        });

        return { success: true, sentCount, errorCount };
    } catch (error) {
        logger.error('Error general en notifyAppointmentScheduled:', error);
        return { success: false, error: error.message };
    }
}
