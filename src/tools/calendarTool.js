import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { calendarService } from "../services/calendarService.js";

export const agendarReunionTool = tool(
    async ({ nombre_cliente, fecha_hora_iso, email_cliente, telefono_cliente }) => {
        try {
            const result = await calendarService.agendarReunionGoogle(nombre_cliente, fecha_hora_iso, {
                emailCliente: email_cliente,
                telefonoCliente: telefono_cliente
            });
            
            if (result.success) {
                let responseText = `✅ Éxito: ${result.message}\n`;
                if (result.meetLink) {
                    responseText += `📹 Enlace de la videollamada (Unirse a la reunión): ${result.meetLink}\n`;
                }
                responseText += `📌 Enlace del evento en Google Calendar: ${result.eventLink || 'No disponible'}`;
                return responseText;
            } else if (result.isOccupied) {
                return `⚠️ Horario Ocupado: El horario indicado ya se encuentra reservado en el calendario. Por favor sugiere amablemente otra hora o fecha al cliente.`;
            } else {
                return `❌ Fallo: ${result.message}`;
            }
        } catch (error) {
            return `Error inesperado al ejecutar agendar_reunion: ${error.message}`;
        }
    },
    {
        name: "agendar_reunion",
        description: "Agenda una reunión en Google Calendar con enlace de Google Meet. Solo usar cuando el cliente haya confirmado una fecha y hora exacta.",
        schema: z.object({
            nombre_cliente: z.string().describe("El nombre completo o nombre de pila del cliente."),
            fecha_hora_iso: z.string().describe("La fecha y hora exacta de la reunión en formato ISO 8601 con zona horaria America/Bogota (ejemplo: 2026-07-28T09:00:00-05:00). NUNCA usar años pasados como 2023 o 2024; guiarse estrictamente por el año actual 2026 y la tabla determinista de fechas dada en las instrucciones."),
            email_cliente: z.string().optional().describe("El correo electrónico del cliente para enviarle la invitación al evento si lo proporcionó."),
            telefono_cliente: z.string().optional().describe("El número de teléfono o celular del cliente para incluirlo en los datos del evento."),
        })
    }
);
