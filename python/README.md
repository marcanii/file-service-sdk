# ntropix-file-service

SDK de Python del **File Service de ntropix**: subir, consultar y servir archivos desde el backend
de tu proyecto. Python ≥ 3.9, sin dependencias (solo la biblioteca estándar).

## Instalación

Por ahora no está en PyPI: se instala desde GitHub, fijando la versión con su tag.

```bash
pip install "ntropix-file-service @ git+https://github.com/ntropix/file-service-sdk@v1.1.0#subdirectory=python"
```

En `requirements.txt` va la misma línea; en `pyproject.toml`:

```toml
dependencies = ["ntropix-file-service @ git+https://github.com/ntropix/file-service-sdk@v1.1.0#subdirectory=python"]
```

> Es un SDK **de servidor**: la API key vive solo en tu backend. El navegador sube los bytes
> directo al storage con URLs firmadas que le entrega tu endpoint de subida.

## Cliente

```python
import os
from ntropix_file_service import FileService

fs = FileService(
    api_key=os.environ["FS_API_KEY"],          # fsk_live_... / fsk_test_...
    base_url="https://files.ntropix.dev",
    timeout=30,                                # segundos por request
    retries=2,                                 # ante red, 429 y 5xx (create_upload: solo 429)
)
```

Todas las operaciones aceptan `actor="user_42"` (header `FS-Actor`): el usuario final que origina
la acción, para la auditoría.

## Subidas desde el navegador

Montá **un** endpoint `POST` que autentique al usuario con tu mecanismo de siempre y delegue en
`handle_upload(body, owner_ref)`. Implementa el protocolo completo (`create` / `parts` /
`complete`, token de subida, errores) y nunca lanza: devuelve `UploadResult(status, body, file)`.

**FastAPI**

```python
@app.post("/api/files")
def files_endpoint(body: dict = Body(...), user: User = Depends(current_user)):
    r = fs.handle_upload(body, owner_ref=user.id)
    return JSONResponse(r.body, status_code=r.status)
```

(Endpoint `def`, no `async def`: el SDK es bloqueante y FastAPI lo corre en su threadpool.)

**Django**

```python
@require_POST
def files_endpoint(request):
    owner = str(request.user.pk) if request.user.is_authenticated else ""  # "" → 401
    r = fs.handle_upload(request.body, owner_ref=owner)
    return JsonResponse(r.body, status=r.status)
```

Sin `@csrf_exempt`: el navegador manda el token CSRF con la opción `headers` de `upload()`:

```ts
await upload(file, { endpoint: "/api/files", headers: { "X-CSRFToken": getCookie("csrftoken") } });
```

**Flask**

```python
@app.post("/api/files")
@login_required
def files_endpoint():
    r = fs.handle_upload(request.get_data(), owner_ref=current_user.get_id())
    return r.body, r.status
```

Opciones: `visibility="public"`, `metadata={...}` (la del backend pisa, clave por clave, a la del
navegador) y `wait_timeout=30` (segundos que `complete` espera la verificación; si vence, responde
igual `200` con el archivo en `READY` y el webhook avisa al terminar).

**Navegador** (el mismo helper funciona con backends en cualquier lenguaje):

```ts
import { upload } from "@ntropix/file-service/browser";

const file = await upload(input.files[0], { endpoint: "/api/files", onProgress: (p) => setProgress(p.percent) });
// file.status === "AVAILABLE"
```

## Subidas desde el servidor

Para archivos que genera tu backend (reportes, exports…). Acepta `bytes`, una ruta o un archivo
binario abierto; en multipart lee una parte por vez, sin cargar el archivo entero en memoria.

```python
file = fs.upload("reporte.pdf", "application/pdf", "/tmp/reporte.pdf", owner_ref="user_42")
```

Por defecto espera a que quede `AVAILABLE` (`wait=True` = 30 s, `wait=120` = 120 s, `wait=False`
no espera). Las piezas sueltas también están: `create_upload`, `sign_parts`,
`complete(id, parts=None, wait=...)` y `wait_until_available(id, timeout=30)`.

**Checksum declarado.** Con `bytes`, una ruta o un archivo con seek, `upload` calcula el SHA-256 por
bloques (sin cargar el archivo en memoria) y lo declara al crear la subida. En subida simple el
storage rechaza un contenido distinto (`FileServiceError` con `code == "checksum_mismatch"`); en
multipart el archivo termina `FAILED` (`FileRejectedError` si esperás). Un stream sin seek no se
hashea: pasá `sha256=` (64 hex en minúscula) si ya lo conocés. `create_upload(..., sha256=...)`
también lo acepta. Un formato inválido falla con `code == "validation"` sin llamar a la API.

## Consultar y descargar

```python
file = fs.get(file_id)                                # FileInfo; file.download solo si AVAILABLE
url = fs.get_download_url(file_id, inline=True)       # URL firmada de vida corta

page = fs.list(owner_ref="user_42", limit=50)         # FilePage(files, next_cursor)
for f in fs.iter_all(owner_ref="user_42"):            # recorre todas las páginas
    ...

usage = fs.usage()                                    # Usage(used_bytes, quota_bytes, file_count, ...)

fs.update(file_id, visibility="public")               # f.public_url: URL estable, sirve en <img src>
fs.update(file_id, name="contrato-firmado.pdf")
fs.delete(file_id)                                    # papelera
fs.restore(file_id)
fs.purge(file_id)                                     # Purga anticipada: definitiva, en el acto
```

`FileInfo` es un dataclass: `id`, `project`, `status`, `name`, `mime_type` (el tipo **real** una vez
verificado), `size`, `content_hash`, `owner_ref`, `visibility`, `public_url`, `metadata`,
`created_at`, `deleted_at`, `download` (`url`, `expires_at`), `reason` (solo en eventos
`file.failed`/`file.quarantined`). `to_dict()` lo da en camelCase.

## Webhooks

Eventos `file.available`, `file.failed` y `file.quarantined`. Verificá la firma con el body
**crudo** (antes de parsearlo):

```python
from ntropix_file_service import FileService, WebhookSignatureError

try:
    event = FileService.verify_webhook(raw_body, headers.get("FS-Signature"), os.environ["FS_WEBHOOK_SECRET"])
except WebhookSignatureError:
    return 400
if not already_processed(event.id):        # la entrega es at-least-once
    handle(event.type, event.file)
return 200                                 # responder 2xx en menos de 10 s
```

Rechaza firmas inválidas y eventos con más de `tolerance=300` segundos.

## Errores

`FileServiceError(status, code, message)`: `status` es el HTTP (0 si no hubo respuesta) y `code`
es estable. `err.request_id` trae el `X-Request-ID` de la respuesta (`None` en `network` /
`timeout`): logueálo e incluilo al reportar un problema.

| status | `code` | Cuándo |
|---|---|---|
| 400 | `validation` | Body o parámetros inválidos |
| 401 | `unauthorized` | API key ausente, inválida o revocada |
| 403 | `forbidden` / `project_disabled` | Key de solo lectura escribiendo / Proyecto desactivado |
| 404 | `not_found` | El archivo no existe en el Proyecto |
| 409 | `invalid_state` / `no_bytes` | El estado no permite la operación / `complete` sin bytes |
| 413 | `too_large` | Supera el máximo del Proyecto |
| 415 | `type_not_allowed` | Tipo declarado fuera de la allowlist |
| 422 | `quarantined` / `failed` | `FileRejectedError`: el servicio rechazó el contenido (`err.file`) |
| 429 | `rate_limited` | Límite de requests (se reintenta respetando `Retry-After`, tope 60 s) |
| 507 | `quota_exceeded` / `storage_full` | Cuota del Proyecto / tope global |
| 0 | `network` / `timeout` | No se pudo hablar con el servicio, o la espera venció |

`handle_upload` traduce todo esto al cuerpo `{"error": {"code", "message"}}` con el mismo status,
salvo dos casos que responde como `502` conservando el `code`: los de red (`network` / `timeout`) y
la API key del backend rechazada (`unauthorized` / `forbidden` / `project_disabled`), que es un
problema de configuración del servidor y no debe confundirse con un usuario sin sesión. Los `401` y
`403` que ve el navegador son solo suyos: usuario no identificado (`owner_ref` vacío) y token de
subida inválido, vencido o ajeno.

## Licencia

MIT.
