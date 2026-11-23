# Protocolo de subida desde el navegador

Contrato entre el helper de navegador (`@ntropix/file-service/browser` → `upload()`) y el
**endpoint de subida** que cada Proyecto monta en su backend con `handleUpload()` del SDK de su
lenguaje (JS, Python, Go, PHP). Como el protocolo es el mismo en todos los SDKs, el mismo helper de
navegador funciona con cualquier backend.

```
Navegador                         Backend del Proyecto (1 endpoint)          File Service
   │ POST {action:"create"} ─────▶ handleUpload(body, ownerRef) ───────────▶ POST /files
   │ ◀──── {id, token, upload}
   │ PUT bytes ──────────────────────────────────────────────────────────────▶ Storage (URL firmada)
   │ POST {action:"parts"} ──────▶ handleUpload  (solo multipart) ─────────▶ POST /files/{id}/parts
   │ POST {action:"complete"} ───▶ handleUpload ───────────────────────────▶ POST /files/{id}/complete
   │ ◀──── FileInfo (AVAILABLE)                                               + espera la verificación
```

La API key **nunca** sale del backend. El backend autentica al usuario con su propio mecanismo
(sesión, JWT…) y le pasa a `handleUpload` el `ownerRef` (id del Usuario final).

## Requests

Siempre `POST <endpoint>` con `Content-Type: application/json`. El campo `action` elige la operación.

### `create`

```json
{ "action": "create", "name": "foto.jpg", "mimeType": "image/jpeg", "size": 183042, "metadata": { "album": "x" } }
```

`metadata` es opcional. El backend fija `ownerRef` (y opcionalmente `visibility` y metadata propia,
que se mezcla clave por clave sobre la del cliente). Respuesta `200`:

```json
{
  "id": "0193…",
  "token": "1731336400.2f23…",
  "upload": { "mode": "simple", "url": "https://storage…", "headers": { "Content-Type": "image/jpeg" }, "expiresAt": "…" }
}
```

En multipart, `upload` es `{ "mode": "multipart", "partSize": 8388608, "partCount": 7, "expiresAt": "…" }`.

### `parts` (solo multipart)

```json
{ "action": "parts", "id": "0193…", "token": "…", "partNumbers": [1, 2] }
```

Hasta 100 partes por request. Respuesta `200`: `{ "urls": [ { "partNumber": 1, "url": "…" } ] }`.
Cada parte se sube con `PUT <url>`; el storage devuelve un header `ETag` que hay que guardar.

### `complete`

```json
{ "action": "complete", "id": "0193…", "token": "…", "parts": [ { "partNumber": 1, "etag": "…" } ] }
```

`parts` solo en multipart. El backend llama a `complete` y espera la verificación (default 30 s).
Respuesta `200`: un **FileInfo**. Si la espera vence, devuelve igual `200` con el file en `READY`
(la verificación sigue; el webhook avisa al terminar).

## FileInfo

```json
{
  "id": "0193…", "project": "mi-app", "status": "AVAILABLE", "name": "foto.jpg",
  "mimeType": "image/jpeg", "size": 183042, "contentHash": "c240…", "ownerRef": "user_1",
  "visibility": "private", "publicUrl": "https://…", "metadata": {}, "createdAt": "…",
  "deletedAt": "…", "download": { "url": "…", "expiresAt": "…" }
}
```

camelCase. Los campos opcionales (`contentHash`, `ownerRef`, `publicUrl`, `deletedAt`, `download`)
pueden faltar o venir en `null`.

## Errores

Cualquier error responde `{ "error": { "code": "…", "message": "…" } }` con el status HTTP:

| status | `code` | Cuándo |
|---|---|---|
| 400 | `validation` | Body inválido, `action` desconocida, falta `id`, o `partNumbers` vacío / con más de 100 |
| 401 | `unauthorized` | El backend no pudo identificar al usuario (lo decide el adaptador del framework) |
| 403 | `forbidden` | `token` ausente, inválido, vencido o de otro usuario |
| 405 | `method_not_allowed` | Método distinto de POST (solo adaptadores que reciben el request HTTP) |
| 422 | `quarantined` / `failed` | El servicio rechazó el contenido al verificarlo |
| 4xx/5xx | los de la API | Se propagan tal cual (`too_large`, `type_not_allowed`, `quota_exceeded`…) |
| 502 | `unauthorized` / `forbidden` / `project_disabled` | La **API key del backend** fue rechazada por el File Service. Es un problema de configuración del servidor, no del usuario: nunca se propaga como 401/403 |
| 502 | `network` / `timeout` | El backend no pudo hablar con el File Service |
| 500 | `internal` | Error inesperado dentro de `handleUpload` (nunca lanza) |

Precisiones:

- `metadata`: la del backend se mezcla **clave por clave** sobre la del cliente (`{...cliente, ...backend}`).
- El cliente distingue por **status**, no solo por `code` (un `forbidden` puede ser 403 del token o 502 de la key del backend).
- `complete` es idempotente: repetirlo tras una espera vencida vuelve a esperar.
- `FS-Actor`: por defecto `handleUpload` audita con el `ownerRef`.
- `ownerRef` vacío o ausente → `401 unauthorized` (lo resuelve `handleUpload`, además del adaptador).
- Un `422` lleva solo el cuerpo de error; el SDK puede exponer el file rechazado al backend
  (`result.file`), pero no lo manda al navegador.
- CSRF: si el framework lo exige (Django, Laravel), el navegador lo envía con la opción `headers`
  de `upload()`, p. ej. `headers: { "X-CSRFToken": csrf }`.

## Token de subida

Prueba sin estado de que el `id` lo creó **este** usuario: sin él, un usuario podría completar o
firmar partes de un file ajeno del mismo Proyecto.

```
token = "<exp>.<hex(HMAC-SHA256(key = apiKey, msg = "fs-upload-token.v1:<id>:<ownerRef>:<exp>"))>"
```

- `exp`: segundos Unix, `now + 86400` (24 h, igual que `ABANDONED_UPLOAD_TIMEOUT`).
- Validación: `exp > now` y comparación en tiempo constante, recalculando con el `ownerRef` del
  usuario autenticado en **ese** request.
- Rotar la API key invalida los tokens de las subidas en curso (raro y aceptable).

Los vectores de prueba compartidos viven en [`testdata/vectors.json`](./testdata/vectors.json):
todo SDK debe pasar los mismos.

## Firma de webhooks

`FS-Signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, "<t>.<body crudo>"))>`. Comparar en tiempo
constante y rechazar si `|now - t| > 300 s`. Vectores en el mismo archivo.
