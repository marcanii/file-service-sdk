# ntropix/file-service (PHP)

SDK de PHP del File Service de ntropix. PHP ≥ 8.1, sin dependencias (solo `ext-curl` y `ext-json`).

Va **solo en el backend**: la API key nunca llega al navegador. El navegador sube los bytes directo
al storage con el helper JS `@ntropix/file-service/browser`, hablando con un único endpoint de tu
backend que resuelve `handleUpload()` (protocolo en [`PROTOCOL.md`](../PROTOCOL.md)).

## Instalación

```bash
composer require ntropix/file-service
```

```bash
FILE_SERVICE_URL=https://files.ntropix.dev
FILE_SERVICE_KEY=fsk_live_...          # secreto: solo en el servidor
FILE_SERVICE_WEBHOOK_SECRET=whsec_...  # solo si usás webhooks
```

## Cliente

```php
use Ntropix\FileService\FileService;

$fs = new FileService(getenv('FILE_SERVICE_KEY'), getenv('FILE_SERVICE_URL'));
// opcional: timeout: 30 (segundos), retries: 2
```

Se reintenta solo lo que es seguro repetir (todo salvo `createUpload`) ante errores de red, `429` y
`5xx`, respetando `Retry-After`. Toda operación acepta `actor:` (id del usuario final, va al header
`FS-Actor` y queda en la auditoría).

## Endpoint de subida

Un solo `POST` en tu backend. Vos autenticás al usuario y pasás su id como `ownerRef`;
`handleUpload` crea la subida, firma partes, completa y espera la verificación. Nunca lanza:
devuelve un `UploadResult` (`status`, `body`, `file`).

**Laravel** (`routes/web.php`, con `$fs` registrado como singleton en un service provider):

```php
Route::post('/api/files', function (Request $request, FileService $fs) {
    $r = $fs->handleUpload($request->getContent(), ownerRef: (string) $request->user()?->id);
    return response()->json($r->toArray(), $r->status);
})->middleware('auth');
```

Las rutas de `web.php` tienen CSRF: el navegador manda el token con la opción `headers` de
`upload()` (ver abajo), o declarás la ruta en `routes/api.php` con tu auth de API.

**Symfony**:

```php
#[Route('/api/files', methods: ['POST'])]
public function upload(Request $request, FileService $fs): JsonResponse
{
    $r = $fs->handleUpload($request->getContent(), ownerRef: (string) $this->getUser()?->getUserIdentifier());
    return new JsonResponse($r->json(), $r->status, [], true);
}
```

**PHP plano**:

```php
session_start();
$r = $fs->handleUpload(file_get_contents('php://input'), ownerRef: (string) ($_SESSION['user_id'] ?? ''));
if ($r->isOk() && $r->file) { /* guardar $r->file->id en tu base */ }
$r->send(); // status + Content-Type: application/json + body
```

Opciones: `visibility:` (la fija el backend, no el navegador), `metadata:` (se mezcla clave por clave
sobre la del navegador; gana la tuya), `waitTimeout:` (segundos de espera de la verificación; si
vence responde `200` con el file en `READY` y el webhook avisa al terminar).

`$r->file` (un `FileInfo`) viene en el `complete` exitoso y también en un `422` (file rechazado),
para que el backend pueda registrarlo; al navegador solo le llega el error.

## Navegador

Sin bundler:

```html
<input type="file" id="f">
<script type="module">
  import { upload } from "https://cdn.jsdelivr.net/npm/@ntropix/file-service/dist/browser.js";

  document.getElementById("f").addEventListener("change", async (e) => {
    const file = await upload(e.target.files[0], {
      endpoint: "/api/files",
      onProgress: (p) => console.log(p.percent + "%"),
      // Laravel (rutas web): token CSRF
      headers: { "X-CSRF-TOKEN": document.querySelector("meta[name=csrf-token]").content },
    });
    console.log(file.id, file.status); // AVAILABLE
  });
</script>
```

Con bundler: `import { upload } from "@ntropix/file-service/browser";` y la misma llamada.

## Descarga

```php
$url = $fs->getDownloadUrl($id);              // URL firmada de vida corta
$url = $fs->getDownloadUrl($id, inline: true); // mostrar en el navegador (imágenes, video, audio, PDF)
$file = $fs->get($id);                        // FileInfo; $file->download['url'] si está AVAILABLE
```

Otras operaciones:

```php
$page = $fs->list(ownerRef: 'user_1', limit: 50);   // FilePage: ->files, ->nextCursor
foreach ($fs->listAll(ownerRef: 'user_1') as $file) { /* recorre todas las páginas */ }
$fs->update($id, visibility: Visibility::Public);    // ->publicUrl: URL estable sin credencial
$fs->delete($id);                                    // papelera
$fs->restore($id);

// Subida desde el servidor (PDF generado, etc.): string, stream o SplFileInfo.
// Lee por partes: un archivo grande no se carga entero en memoria.
$file = $fs->upload(name: 'reporte.pdf', mimeType: 'application/pdf', data: new SplFileInfo('/tmp/r.pdf'));
```

Para archivos del usuario preferí el endpoint de subida: así los bytes no pasan por tu backend.

## Webhooks

```php
use Ntropix\FileService\WebhookSignatureException;

try {
    $event = FileService::verifyWebhook(
        file_get_contents('php://input'),        // body CRUDO, sin parsear
        $_SERVER['HTTP_FS_SIGNATURE'] ?? null,
        getenv('FILE_SERVICE_WEBHOOK_SECRET'),
    );
} catch (WebhookSignatureException) {
    http_response_code(400);
    exit;
}
// $event->id (descartar duplicados: la entrega es at-least-once), $event->type, $event->file
http_response_code(204);
```

Eventos: `file.available`, `file.failed`, `file.quarantined`. Rechaza firmas que no coinciden y
eventos de más de 5 minutos.

## Errores

```php
use Ntropix\FileService\{FileRejectedException, FileServiceException};

try {
    $file = $fs->complete($id, wait: true);
} catch (FileRejectedException $e) {
    // 422: $e->errorCode es 'quarantined' o 'failed'; el file en $e->fileInfo
} catch (FileServiceException $e) {
    // $e->status (0 si no hubo respuesta) y $e->errorCode: not_found, too_large,
    // type_not_allowed, quota_exceeded, rate_limited, network, timeout…
    // $e->requestId: X-Request-ID de la respuesta (null si no hubo); incluilo al reportar.
}
```

## Licencia

MIT
