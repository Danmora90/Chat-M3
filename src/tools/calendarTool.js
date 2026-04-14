import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { calendarService } from "../services/calendarService.js";

export const agendarReunionTool = tool(
    async ({ nombre_cliente, fecha_hora_iso }) => {
        try {
            const result = await calendarService.agendarReunionGoogle(nombre_cliente, fecha_hora_iso);
            
            if (result.success) {
                return `✅ Éxito: ${result.message}\nEnlace del evento: ${result.eventLink || 'No disponible'}`;
            } else {
                return `❌ Fallo: ${result.message}`;
            }
        } catch (error) {
            return `Error inesperado al ejecutar agendar_reunion: ${error.message}`;
        }
    },
    {
        name: "agendar_reunion",
        description: "Agenda una reunión en Google Calendar. Solo usar cuando el cliente haya confirmado una fecha y hora exacta.",
        schema: z.object({
            nombre_cliente: z.string().describe("El nombre completo o nombre de pila del cliente."),
            fecha_hora_iso: z.string().describe("La fecha y hora de la reunión en formato ISO 8601 (ejemplo: 2026-03-25T10:00:00-05:00). Asegúrate de que el formato sea estricto de ISO 8601."),
        })
    }
);
