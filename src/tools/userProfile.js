import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabaseAdmin, updateUser } from "../services/supabase.js";

export const updateUserDisplayNameTool = tool(
    async ({ name }, config) => {
        try {
            // 1. Obtener thread_id de la configuración
            const threadId = config.configurable?.thread_id;
            if (!threadId) {
                return "Error: No se pudo identificar la conversación.";
            }

            // 2. Extraer chatId del thread_id (formato: conversation_{chatId})
            const chatId = threadId.replace('conversation_', '');

            // 3. Buscar el user_id asociado al chat
            const { data: chat, error: chatError } = await supabaseAdmin
                .from('chats')
                .select('user_id')
                .eq('id', chatId)
                .single();

            if (chatError || !chat) {
                return "Error: No se pudo encontrar el chat asociado.";
            }

            // 4. Actualizar el usuario usando la función de servicio
            const updatedUser = await updateUser(chat.user_id, { display_name: name });

            return `Nombre actualizado correctamente a: ${updatedUser.display_name}. Puedes continuar la conversación llamando al usuario por su nombre.`;
        } catch (error) {
            console.error('Error updating user name:', error);
            return "Hubo un error al actualizar el nombre.";
        }
    },
    {
        name: "update_user_display_name",
        description: "Actualiza el nombre del usuario en su perfil. Úsala cuando el usuario te diga su nombre explícitamente.",
        schema: z.object({
            name: z.string().describe("El nombre que el usuario ha indicado")
        })
    }
);
