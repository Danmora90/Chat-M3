# Media Handling (Imágenes/Audio/Video/PDF)

Este documento describe cómo el backend recibe, almacena y expone adjuntos enviados por WhatsApp (Twilio), y cómo el frontend debe renderizarlos.

## Flujo End-to-End

1. Twilio envía el webhook `POST /webhook/whatsapp` con:
   - `MessageSid`
   - `NumMedia`
   - `MediaUrl{i}` y `MediaContentType{i}` (para i = 0..NumMedia-1)
2. El backend descarga cada adjunto desde Twilio (Basic Auth) y lo sube a Supabase Storage (bucket `chat-media`).
3. El backend guarda el mensaje en `messages` y persiste:
   - `message_sid` (columna) para idempotencia
   - `metadata.attachments[]` (lista de adjuntos)
4. El frontend obtiene mensajes vía `GET /api/conversations/:id/messages`.
   - `attachments` es un array de URLs renderizables.
   - `attachments_info` incluye metadatos por URL (`contentType`, `source`, etc).

## Contrato de adjuntos

Cada mensaje puede incluir:

- `attachments: string[]`
- `attachments_info: Array<{ url: string, contentType: string | null, source: 'signed'|'proxy', storage_path?: string|null, original_url?: string|null }>`

### source = signed
- La URL apunta a una Signed URL de Supabase Storage.
- Se puede renderizar directamente en:
  - `<img src>`
  - `<audio src>`
  - `<video src>`
  - `<iframe src>` (PDF)

### source = proxy
- La URL apunta a `/api/media/proxy?url=...`.
- Está protegida por JWT (Authorization Bearer).
- Los tags nativos NO pueden enviar headers custom, así que el frontend debe usar `fetch` + `Authorization` y convertir a Blob URL.

## Variables de entorno relevantes

- `TWILIO_MEDIA_HOSTS`: allowlist de hostnames permitidos por el proxy (default: `api.twilio.com`).
- `MEDIA_PROXY_TIMEOUT_MS`: timeout del proxy.
- `MEDIA_PROXY_MAX_BYTES`: límite de tamaño a proxyear.
- `MEDIA_SIGNED_URL_EXPIRES_IN`: TTL de Signed URLs (segundos).

## Idempotencia (Twilio retries)

Twilio puede reenviar el mismo webhook. Para evitar duplicados:

- El backend guarda `MessageSid` en la columna `messages.message_sid`.
- Se recomienda aplicar la migración [database/migration_v4_message_sid_idempotency.sql](database/migration_v4_message_sid_idempotency.sql) para asegurar unicidad por `(chat_id, message_sid)`.

## Troubleshooting rápido

- Si el frontend ve `api.twilio.com` directo en `attachments`, algo no está subiendo/firmeando correctamente.
- Si un adjunto deja de cargar tras horas/días, probablemente expiró la Signed URL (`MEDIA_SIGNED_URL_EXPIRES_IN`).
- Si hay mensajes duplicados, aplicar la migración v4 y verificar que `message_sid` se está insertando.
