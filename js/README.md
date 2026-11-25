# @ntropix/file-service

SDK del File Service de ntropix para Node (Next.js, NestJS, Express, Hono…) y el navegador. Sin
dependencias. Hay SDKs equivalentes para [Python](../python), [Go](../go) y [PHP](../php).

- **`@ntropix/file-service`** — cliente de servidor. Usa la API key del proyecto: va **solo** en
  el backend.
- **`@ntropix/file-service/browser`** — helper de navegador. Sube los bytes directo al storage
  (los bytes nunca pasan por tu backend). No conoce la API key.

```
Navegador ── upload(file, { endpoint }) ──▶ Tu backend: 1 endpoint con handleUpload() ──▶ File Service
    └──────────── bytes directo, con URL firmada ─────────────────────────────────────▶ Storage
```

## Instalación

```bash
npm install @ntropix/file-service      # pnpm add · yarn add · bun add
```

Funciona con `import` (ESM: Next.js, Vite, Bun) y con `require` (CommonJS: NestJS por defecto),
en Node ≥ 20, con npm, pnpm, yarn (también Plug'n'Play) y bun. Tipos de TypeScript incluidos.

Variables de entorno del backend (la key se emite en el Panel del File Service):

```bash
FILE_SERVICE_URL=https://files.ntropix.dev
FILE_SERVICE_KEY=fsk_live_...          # secreto: nunca con prefijo NEXT_PUBLIC_
FILE_SERVICE_WEBHOOK_SECRET=whsec_...  # solo si usás webhooks
```

## Integración en 2 pasos

Tu backend monta **un** endpoint de subida; el navegador llama a `upload()`. El SDK resuelve el
resto: subida directa al storage (simple o multipart), firma de partes, verificación y un token
que impide que un usuario complete subidas de otro.

### 1. Backend: un endpoint

**Next.js (App Router)**

```ts
// lib/files.ts
import "server-only";
import { FileService } from "@ntropix/file-service";
export const fs = new FileService({ apiKey: process.env.FILE_SERVICE_KEY!, baseUrl: process.env.FILE_SERVICE_URL! });
```

```ts
// app/api/files/route.ts
import { createUploadRoute } from "@ntropix/file-service";
import { fs } from "@/lib/files";

export const { POST } = createUploadRoute(fs, {
  auth: async () => (await getSession())?.user.id,          // TU autenticación; null → 401
  onComplete: (file, { ownerRef }) => db.documents.create({ ownerRef, fileId: file.id }),  // opcional
});
```

`createUploadRoute` sirve igual para Hono, Remix, SvelteKit, Bun y Deno (todo lo que use
`Request`/`Response` estándar).

**NestJS**

```ts
// files.controller.ts
import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import { FileService } from "@ntropix/file-service";

const fs = new FileService({ apiKey: process.env.FILE_SERVICE_KEY!, baseUrl: process.env.FILE_SERVICE_URL! });

@Controller("api/files")
export class FilesController {
  @Post()
  @UseGuards(AuthGuard)                                       // TU guard
  async upload(@Body() body: unknown, @Req() req, @Res() res) {
    const r = await fs.handleUpload(body, { ownerRef: req.user.id });
    if (r.file) await this.documents.save({ ownerRef: req.user.id, fileId: r.file.id });  // opcional
    res.status(r.status).json(r.body);
  }
}
```

**Express** (o cualquier otro framework): es lo mismo, `handleUpload(body, { ownerRef })` devuelve
`{ status, body, file? }` listo para responder.

```ts
app.post("/api/files", requireUser, async (req, res) => {
  const r = await fs.handleUpload(req.body, { ownerRef: req.user.id });
  res.status(r.status).json(r.body);
});
```

Opciones de `handleUpload` / `createUploadRoute`: `visibility` (la fija el backend, default
`private`), `metadata` (pisa la del navegador), `waitTimeoutMs` (espera de verificación, default 30 s).

### 2. Navegador: `upload()`

```tsx
"use client";
import { upload, UploadError } from "@ntropix/file-service/browser";

const file = await upload(input.files[0], {
  endpoint: "/api/files",
  onProgress: (p) => setPercent(p.percent),
});
// file.status === "AVAILABLE" → ya verificado (hash + tipo real). file.id es lo que guardás.
```

Si tu framework exige CSRF (Django, Laravel con rutas `web`), mandá el token con `headers`:
`upload(file, { endpoint, headers: { "X-CSRF-TOKEN": token } })`.

Si el endpoint de subida está en **otro origen** y se autentica con cookies, pasá
`credentials: "include"` (default `"same-origin"`); el endpoint debe responder CORS con credenciales:
`upload(file, { endpoint: "https://api.miapp.com/files", credentials: "include" })`.
El `PUT` de bytes (simple o por parte) se reintenta (`retries`, default 3, con backoff) solo ante
errores de red y `5xx`; un `4xx` falla de inmediato.

En subidas simples (menos de 32 MB) `upload()` calcula el SHA-256 del archivo con WebCrypto y lo
declara en `create`: el storage rechaza cualquier otro contenido (ver [PROTOCOL.md](../PROTOCOL.md)).
Requiere contexto seguro (`https://` o `localhost`); sin WebCrypto la subida sigue sin Checksum declarado.

Errores: `UploadError` con `status` y `code` (`too_large`, `type_not_allowed`, `quota_exceeded`,
`quarantined`, `unauthorized`, `checksum_mismatch`…). Sin bundler (ej. un backend PHP o Python con HTML plano):

```html
<script type="module">
  import { upload } from "https://cdn.jsdelivr.net/npm/@ntropix/file-service@1/dist/browser.js";
  const file = await upload(document.querySelector("input[type=file]").files[0], { endpoint: "/api/files" });
</script>
```

El endpoint habla el [protocolo de subida](../PROTOCOL.md), que es el mismo en los SDKs de Python,
Go y PHP: este helper funciona con cualquiera de esos backends.

### 3. Mostrar y descargar

```ts
// Privado (default): URL firmada de vida corta, pedida en el momento.
const url = await fs.getDownloadUrl(fileId, { actor: user.id });        // baja como adjunto
const preview = await fs.getDownloadUrl(fileId, { inline: true });      // se muestra en el navegador

// Público: URL estable, se guarda y se usa directo en <img src>.
const { publicUrl } = await fs.update(fileId, { visibility: "public" });
```

"Público" significa accesible para cualquiera que tenga el link. Para lo sensible, dejalo privado.

### Control fino (opcional)

Si necesitás manejar cada paso a mano, el cliente expone las operaciones de bajo nivel:
`createUpload` → (navegador: `uploadFile(file, upload, { signParts })`) → `signParts` → `complete`. El helper firma las partes por lotes (`signBatchSize`, default 10) y renueva una URL vencida sin abortar (ver PROTOCOL.md).
Ver la referencia abajo.

## Referencia

| Método | Qué hace |
|---|---|
| `fs.handleUpload(body, { ownerRef })` | Endpoint de subida completo → `{ status, body, file? }` |
| `createUploadRoute(fs, { auth, onComplete? })` | Lo mismo como `{ POST }` para Next.js / Request estándar |
| `fs.createUpload(input, opts?)` | Inicia una subida → `{ id, status, upload }` |
| `fs.signParts(id, partNumbers)` | Firma URLs de partes (multipart, hasta 100 por llamada) |
| `fs.complete(id, { parts?, wait? })` | Cierra la subida. Idempotente. Con `wait` espera a `AVAILABLE` |
| `fs.waitUntilAvailable(id, opts?)` | Espera la verificación; lanza `FileRejectedError` si se rechaza |
| `fs.get(id, { inline? })` | Metadatos + URL firmada de descarga (si está disponible) |
| `fs.getDownloadUrl(id, { inline? })` | Atajo: solo la URL firmada |
| `fs.list({ ownerRef?, status?, trashed?, cursor?, limit? })` | Una página → `{ files, nextCursor }` |
| `fs.listAll(opts?)` | Iterador asíncrono sobre todas las páginas |
| `fs.usage()` | Uso y Cuota del Proyecto → `{ usedBytes, quotaBytes, fileCount, maxFileSize, allowedMimeTypes }` (sirve con key `read`) |
| `fs.update(id, { visibility?, name? })` | Cambia visibilidad y/o nombre |
| `fs.delete(id)` | Manda a la papelera (recuperable) |
| `fs.restore(id)` | Recupera de la papelera |
| `fs.purge(id)` | Purga anticipada: borra en el acto y sin vuelta atrás, esté o no en la papelera |
| `fs.upload({ ...input, data })` | Sube desde el servidor en una llamada (ej. un PDF generado). Calcula y declara el SHA-256 |
| `FileService.verifyWebhook({ payload, signature, secret })` | Verifica la firma y devuelve el evento |

Todas las operaciones aceptan `{ actor, signal }`. `actor` es el id del usuario final que originó
la acción: solo queda en la auditoría del File Service.

### Estados

`PENDING` → `UPLOADING` (multipart) → `READY` (bytes confirmados, en verificación) → **`AVAILABLE`**
(descargable). Si la verificación lo rechaza: `FAILED` (corrupto) o `QUARANTINED` (el tipo real del
contenido no está permitido, sin importar la extensión o el tipo declarado).

### Errores

Todo error de la API es un `FileServiceError` con `status` (HTTP) y `code` estable:

| `code` | HTTP | Significado |
|---|---|---|
| `unauthorized` | 401 | API key inválida, vencida o revocada |
| `forbidden` | 403 | La key es de solo lectura |
| `project_disabled` | 403 | El proyecto fue desactivado |
| `not_found` | 404 | No existe (o es de otro proyecto) |
| `validation` | 400 | Datos inválidos |
| `invalid_state` / `no_bytes` | 409 | El estado no permite la operación / no se subieron los bytes |
| `too_large` | 413 | Supera el tamaño máximo del proyecto |
| `type_not_allowed` | 415 | El tipo no está en la lista permitida del proyecto |
| `quota_exceeded` / `storage_full` | 507 | Cuota del proyecto agotada / el servicio no tiene espacio |
| `rate_limited` | 429 | Demasiadas solicitudes (el SDK reintenta solo) |
| `network` / `timeout` | 0 | No se pudo conectar / no respondió a tiempo |
| `storage_rejected` | 4xx | El storage rechazó el `PUT` de bytes de `upload()` |
| `checksum_mismatch` | 400 | El storage rechazó el `PUT` de `upload()`: el contenido no coincide con su `sha256` |

El SDK reintenta automáticamente (con backoff) errores de red, `429` y `5xx` en las operaciones que
son seguras de repetir, y respeta `Retry-After` (segundos o fecha HTTP) con un tope de 60 s.
`createUpload` solo reintenta `429` (la API lo rechaza antes de procesar, no duplica nada), no red ni `5xx`.
El `PUT` de bytes al storage de `upload()` tiene timeout por intento (`timeoutMs`) y reintenta red,
timeout y `5xx`. Todos los requests a la API envían `User-Agent: ntropix-file-service-js/<versión>`.

**Checksum declarado.** `upload()` calcula el SHA-256 de `data` (un `Blob` se lee como stream) y lo
declara al crear la subida; `createUpload({ ..., sha256 })` y `upload({ ..., sha256 })` aceptan uno
explícito (64 hex en minúscula; otro formato → `validation` sin llamar a la API). En subida simple el
storage rechaza un contenido distinto (`checksum_mismatch`); en multipart el archivo termina `FAILED`
(`FileRejectedError` si esperás).

`complete({ wait })`: `false`/`undefined`/`0`/negativo no espera (devuelve el archivo en `READY`);
`true` espera hasta 30 s; un número positivo es el máximo en ms; también acepta `WaitOptions`.

`err.requestId` trae el `X-Request-ID` de la respuesta (`undefined` en `network` / `timeout`):
logueálo e incluilo al reportar un problema, así se encuentra el request en los logs del servicio.

## Webhooks

En vez de (o además de) esperar con `wait`, el File Service puede avisarte cuando un archivo
termina de verificarse. Se configura en el Panel (URL + secret). Eventos: `file.available`,
`file.failed`, `file.quarantined`.

```ts
// app/api/webhooks/files/route.ts
import { FileService, WebhookSignatureError } from "@ntropix/file-service";

export async function POST(req: Request) {
  const payload = await req.text(); // el body CRUDO: no usar req.json()
  try {
    const event = FileService.verifyWebhook({
      payload,
      signature: req.headers.get("fs-signature"),
      secret: process.env.FILE_SERVICE_WEBHOOK_SECRET!,
    });
    // La entrega es at-least-once: descartá duplicados por event.id.
    if (event.type === "file.available") await marcarListo(event.data.file.id);
    else await marcarRechazado(event.data.file.id, event.type);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof WebhookSignatureError) return new Response("firma inválida", { status: 400 });
    throw err;
  }
}
```

Respondé `2xx` rápido; cualquier otra respuesta se reintenta con backoff durante ~24 horas.

## Desarrollo del SDK

`dist/` va versionado: después de tocar `src/`, correr `pnpm build` y commitear también `dist/`.
`npm publish` compila y corre los tests antes de publicar (`prepublishOnly`).

```bash
pnpm install && pnpm build
pnpm test             # tests unitarios (sin red) + vectores compartidos (../testdata)
FS_KEY=fsk_test_... pnpm test:e2e           # contra un File Service levantado (default http://localhost:8080)
FS_KEY=fsk_test_... pnpm test:browser-e2e   # upload() del navegador contra createUploadRoute
```
