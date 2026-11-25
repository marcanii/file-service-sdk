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
{ "action": "create", "name": "foto.jpg", "mimeType": "image/jpeg", "size": 183042, "metadata": { "album": "x" }, "sha256": "c240…" }
```

`metadata` y `sha256` son opcionales. El backend fija `ownerRef` (y opcionalmente `visibility` y metadata propia,
que se mezcla clave por clave sobre la del cliente). Respuesta `200`:

```json
{
  "id": "0193…",
  "token": "1731336400.2f23…",
  "upload": { "mode": "simple", "url": "https://storage…", "headers": { "Content-Type": "image/jpeg", "If-None-Match": "*" }, "expiresAt": "…" }
}
```

En multipart, `upload` es `{ "mode": "multipart", "partSize": 8388608, "partCount": 7, "expiresAt": "…" }`.

**Checksum declarado (`sha256`).** SHA-256 del contenido, 64 hex en **minúscula** (el mismo formato
que `contentHash`). `handleUpload` rechaza otro formato con `400 validation` sin llamar a la API;
ausente o `null`, no se manda. Si es válido lo pasa a `POST /files` y:

- **Subida simple:** `upload.headers` trae además `x-amz-checksum-sha256`, firmado. El navegador lo
  manda tal cual en el `PUT` (como todos los `headers`) y el storage rechaza con `400` un contenido
  distinto, sin escribir nada. El helper traduce ese `400` a `UploadError` con `code:
  "checksum_mismatch"` (status 400), sin reintentar.
- **Multipart:** el storage no puede verificarlo; lo compara el File Service al verificar. Si no
  coincide, el file termina `FAILED`: el `complete` responde `422 failed` (o `200` con el file en
  `READY` si la espera vence, y el webhook `file.failed` avisa después).

El helper lo calcula con WebCrypto solo cuando la subida va a ser simple: archivos de menos de 32 MB
(el umbral de multipart por defecto del servicio) y en contexto seguro (`https://` o `localhost`;
sin WebCrypto no lo manda). Nunca define el `contentHash`, que calcula siempre el servicio. Un backend
con un SDK anterior ignora el campo y la subida funciona igual, sin la garantía.

### `parts` (solo multipart)

```json
{ "action": "parts", "id": "0193…", "token": "…", "partNumbers": [1, 2] }
```

Hasta 100 partes por request. Respuesta `200`: `{ "urls": [ { "partNumber": 1, "url": "…" } ] }`.
Cada parte se sube con `PUT <url>` y exactamente `partSize` bytes (la última, el resto: la URL firma
el tamaño y el storage rechaza otro); el storage devuelve un header `ETag` que hay que guardar.

**Firma por lotes (cliente).** El helper de navegador no pide una firma por parte: cada pedido `parts`
lleva la parte que hace falta más las siguientes de la cola que aún no tienen URL, hasta
`signBatchSize` partes (default 10, máximo 100), y guarda las URLs hasta usarlas. Un archivo de 10 GB
con partes de 8 MB pasa de ~1.250 pedidos a ~125. Si el storage responde `403` a un `PUT` (URL
vencida), el helper descarta esa URL, pide otra firma para esa parte y reintenta una vez sin abortar
la subida; un segundo `403` falla con `UploadError`. Es comportamiento del cliente: el servidor no
cambia.

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
| 400 | `validation` | Body inválido, `action` desconocida, falta `id`, `sha256` con otro formato, o `partNumbers` vacío / con más de 100 |
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
- Un `422` lleva solo el cuerpo de error; los 4 SDKs exponen el file rechazado al backend
  (`result.file`, para que lo registre), pero no lo mandan al navegador.
- Un timeout/fallo de red al cerrar la subida (`complete`) es `502`; solo el timeout de la
  **verificación** (`waitTimeoutMs`) devuelve `200` con el file como está (`READY`).
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
- Formato canónico, validado **antes** de calcular nada (un token que no lo cumple se rechaza sin
  más, y `handleUpload` responde 403, nunca 500): `exp` son 1 a 12 dígitos **ASCII** (`[0-9]`, sin
  dígitos Unicode como `²` o `١`), sin signo, sin espacios ni ceros a la izquierda (`[1-9][0-9]{0,11}`);
  el MAC son exactamente 64 hex en **minúscula**; hay un solo `.`. La firma se calcula sobre `exp` en
  esa misma forma canónica.
- Rotar la API key invalida los tokens de las subidas en curso (raro y aceptable).

## Firma de webhooks

`FS-Signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, "<t>.<body crudo>"))>`. Comparar en tiempo
constante y rechazar si `|now - t| > 300 s`.

Formato canónico (los 4 SDKs lo aplican igual):

- Los campos se separan por `,`, se recortan los espacios alrededor de cada uno y se parten en el
  primer `=`. Las claves desconocidas se ignoran.
- `t` aparece **exactamente una vez** y es un Unix canónico: `[1-9][0-9]{0,11}` en ASCII (igual que
  `exp` del token). La firma se calcula sobre ese texto crudo; un `t` no canónico (`01731250000`,
  `+1731250000`, `²`…) es cabecera malformada aunque su HMAC sea válido.
- `v1` puede repetirse (rotación del secret): se acepta si **alguno** coincide. Cada `v1` válido son 64
  hex en minúscula; los demás se ignoran y, si no queda ninguno, la cabecera es malformada.
- Clasificación del rechazo: cabecera vacía → falta; formato → malformada; ningún `v1` coincide →
  no coincide; fuera de la tolerancia (en ambos sentidos) → vencida.

## Cliente HTTP común

Los 4 SDKs se comportan igual frente a la API:

- **User-Agent:** `ntropix-file-service-<lang>/<versión>` (`js`, `python`, `go`, `php`) en cada request a la API.
- **Reintentos** (default 2, backoff exponencial desde 250 ms): red, `429` y `5xx` en las operaciones
  seguras de repetir. `POST /files` (crear) solo reintenta `429`: la API no procesó nada; repetir tras un
  `5xx` o un corte podría dejar un file huérfano.
- **`Retry-After`** (segundos o fecha HTTP) reemplaza al backoff, con **tope de 60 s**.
- **PUT al storage:** con timeout por intento y reintento ante red/`5xx` cuando el cuerpo se puede
  releer (en JS, también).
- **Checksum declarado en `upload()`:** si la entrada se puede releer (bytes, ruta, archivo o stream
  con seek; en Go, un `io.ReaderAt`), el SDK calcula el SHA-256 leyendo por bloques y lo declara en
  `POST /files`; un stream de una sola pasada no se hashea (ni se bufferiza para eso). `upload()` y
  `createUpload()` aceptan un `sha256` explícito, que no se recalcula; otro formato falla con
  `validation` sin llamar a la API. Un `400` del `PUT` simple con `x-amz-checksum-sha256` firmado es
  `checksum_mismatch` y no se reintenta.
- **`complete` sin espera:** `wait` falso, `0` o negativo (en Go, `Wait: false`) devuelve el file
  recién completado (`READY`) sin consultar. `true` espera hasta 30 s a `AVAILABLE`; un número positivo
  es el máximo de espera, **en segundos en Python y PHP y en milisegundos en JS** (donde también se
  expresa como `{ timeoutMs }`). En Go no hay valor numérico: `Wait: true` espera y `WaitTimeout`
  fija el máximo (`0` = 30 s, no "sin espera"; para no esperar, `Wait: false` / `NoWait: true`).
- **404 tras reintentar:** `DELETE`, `restore`, `purge` y `PATCH` son idempotentes en el servidor,
  pero si un intento tuvo éxito (2xx) y la respuesta se perdió, el reintento puede recibir `404`. El
  SDK **no lo enmascara**: lo devuelve como `not_found`. Quien necesite "borrar de forma garantizada"
  debe tratar `not_found` en `DELETE` o `purge` como éxito.
- **Estados y visibilidades desconocidos** (valores que añada una versión futura de la API) no hacen
  fallar al SDK: se conservan tal cual.

## Vectores

[`testdata/vectors.json`](./testdata/vectors.json) es la fuente de verdad y todo SDK debe pasar los
mismos, incluidos los **negativos**: `uploadToken.negative` (vencido, de otro Owner Ref o id, alterado,
malformado con dígitos Unicode, ceros a la izquierda, MAC en mayúsculas…) debe rechazarse siempre, y
`webhookNegative.rejected` debe fallar con la razón indicada (`missing`, `malformed`, `mismatch`,
`expired`); los de `webhookNegative.accepted` (varios `v1`, claves desconocidas) deben verificar.
