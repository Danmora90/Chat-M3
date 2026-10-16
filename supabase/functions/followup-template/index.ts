import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

// Configuración de CORS estándar para Edge Functions
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
  code?: number | null;
  message?: string | null;
  error_code?: number | null;
  error_message?: string | null;
  more_info?: string | null;
}

Deno.serve(async (req: Request) => {
  // Manejo de preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Obtener variables de entorno
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const twilioAccountSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
    const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
    const twilioPhoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER") || "+573045544151";
    const twilioTemplateSid = Deno.env.get("TWILIO_TEMPLATE_SID") || "HX762ed96002b5a02d8d7f6c36ae7983d8";
    const templateText = Deno.env.get("TWILIO_TEMPLATE_TEXT") || "Holaa!!✨ nuestro mensajito quedó al aire, quieres que retomemos nuestra conversación?";

    // Variables editables de tiempo y reintentos
    const inactivityMinutes = parseInt(Deno.env.get("FOLLOWUP_INACTIVITY_MINUTES") || "5", 10);
    const maxFollowupAttempts = parseInt(Deno.env.get("FOLLOWUP_MAX_ATTEMPTS") || "1", 10);

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Faltan las credenciales internas de Supabase (SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY).");
    }

    if (!twilioAccountSid || !twilioAuthToken) {
      throw new Error("Faltan las credenciales de Twilio (TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN).");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 2. Obtener chats activos que no tengan la IA pausada
    const { data: activeChats, error: chatsError } = await supabase
      .from("chats")
      .select("id, user_id, status, is_ai_paused, last_message_at")
      .eq("status", "active")
      .or("is_ai_paused.is.null,is_ai_paused.eq.false");

    if (chatsError) {
      throw new Error(`Error al consultar chats activos: ${chatsError.message}`);
    }

    if (!activeChats || activeChats.length === 0) {
      return new Response(
        JSON.stringify({ message: "No hay chats activos para evaluar.", processed: 0, sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const now = Date.now();
    const results = {
      evaluated: activeChats.length,
      sent: 0,
      skipped: 0,
      errors: [] as Array<{ chatId: string; error: string; code?: number | null }>,
    };

    // 3. Evaluar cada chat
    for (const chat of activeChats) {
      try {
        // Consultar los últimos 10 mensajes del chat ordenados del más reciente al más antiguo
        const { data: messages, error: msgError } = await supabase
          .from("messages")
          .select("id, role, content, metadata, created_at")
          .eq("chat_id", chat.id)
          .order("created_at", { ascending: false })
          .limit(10);

        if (msgError) {
          console.error(`Error consultando mensajes de chat ${chat.id}:`, msgError);
          results.errors.push({ chatId: chat.id, error: msgError.message });
          continue;
        }

        if (!messages || messages.length === 0) {
          results.skipped++;
          continue;
        }

        const latestMessage = messages[0];

        // Condición 1: El último mensaje debe ser del asistente/agente
        if (latestMessage.role !== "assistant") {
          results.skipped++;
          continue;
        }

        // Condición 2: Validar si han transcurrido los minutos requeridos de inactividad
        const lastMsgTime = new Date(latestMessage.created_at).getTime();
        const minutesSinceLastMsg = (now - lastMsgTime) / (1000 * 60);

        if (minutesSinceLastMsg < inactivityMinutes) {
          results.skipped++;
          continue;
        }

        // Condición 3: Contar cuántos followups consecutivos se han enviado desde el último mensaje del usuario
        let followupCount = 0;
        for (const msg of messages) {
          if (msg.role === "user") {
            // Se detiene al llegar al mensaje del usuario
            break;
          }
          if (msg.role === "assistant" && msg.metadata?.is_followup === true) {
            followupCount++;
          }
        }

        // Si ya se alcanzó el límite máximo de seguimientos permitidos, se ignora
        if (followupCount >= maxFollowupAttempts) {
          results.skipped++;
          continue;
        }

        // 4. Obtener el número de teléfono del usuario
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, phone_number, display_name")
          .eq("id", chat.user_id)
          .single();

        if (userError || !user || !user.phone_number) {
          // Puede ser un chat de Instagram, Web o sin teléfono registrado
          results.skipped++;
          continue;
        }

        // Limpiar y formatear números de teléfono a formato E.164 estricto
        const cleanFrom = twilioPhoneNumber.replace(/^whatsapp:/i, "").trim().replace(/[^\d+]/g, "");
        const cleanTo = user.phone_number.replace(/^whatsapp:/i, "").trim().replace(/[^\d+]/g, "");

        // Si el número no parece un teléfono real o es demasiado corto, omitir
        if (!cleanTo || cleanTo.replace(/\D/g, "").length < 7) {
          console.warn(`Número de teléfono inválido (${user.phone_number}) para chat ${chat.id}`);
          results.skipped++;
          continue;
        }

        const formattedFrom = cleanFrom.startsWith("+") ? cleanFrom : `+${cleanFrom}`;
        const formattedTo = cleanTo.startsWith("+") ? cleanTo : `+${cleanTo}`;

        // 5. Enviar mensaje de WhatsApp mediante Twilio REST API usando el ContentSid
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
        const formData = new URLSearchParams();
        formData.append("To", `whatsapp:${formattedTo}`);
        formData.append("From", `whatsapp:${formattedFrom}`);
        formData.append("ContentSid", twilioTemplateSid);
        // Twilio Content API para WhatsApp requiere ContentVariables (incluso vacío {}) cuando se usa ContentSid
        formData.append("ContentVariables", "{}");

        const twilioAuthHeader = `Basic ${btoa(`${twilioAccountSid}:${twilioAuthToken}`)}`;

        const twilioResponse = await fetch(twilioUrl, {
          method: "POST",
          headers: {
            "Authorization": twilioAuthHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        });

        const twilioResult: TwilioMessageResponse = await twilioResponse.json();

        if (!twilioResponse.ok) {
          const errorMessage = twilioResult.message || twilioResult.error_message || `HTTP ${twilioResponse.status}`;
          console.error(
            `Fallo envío de Twilio para chat ${chat.id} (${formattedTo}): [Code ${twilioResult.code || twilioResponse.status}] ${errorMessage}`
          );
          results.errors.push({
            chatId: chat.id,
            error: errorMessage,
            code: twilioResult.code || twilioResponse.status,
          });
          continue;
        }

        // 6. Registrar el mensaje en la tabla public.messages
        const { error: insertError } = await supabase.from("messages").insert({
          chat_id: chat.id,
          user_id: chat.user_id,
          role: "assistant",
          content: templateText,
          message_sid: twilioResult.sid || null,
          status: "sent",
          metadata: {
            is_followup: true,
            template_sid: twilioTemplateSid,
            attempt: followupCount + 1,
            trigger: "inactivity_cron",
            twilio_status: twilioResult.status,
          },
        });

        if (insertError) {
          console.error(`Error guardando mensaje en DB para chat ${chat.id}:`, insertError);
        }

        // 7. Actualizar el chat
        await supabase
          .from("chats")
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: templateText,
            updated_at: new Date().toISOString(),
          })
          .eq("id", chat.id);

        results.sent++;
        console.log(`[Followup] Template enviado exitosamente al chat ${chat.id} (${formattedTo}). Intento ${followupCount + 1}`);
      } catch (err: any) {
        console.error(`Excepción procesando chat ${chat.id}:`, err);
        results.errors.push({ chatId: chat.id, error: err.message || String(err) });
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    console.error("Error general en Edge Function followup-template:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
