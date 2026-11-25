# Changelog

Los cuatro SDKs (JS, Python, Go y PHP) se versionan juntos. Versionado semántico: un cambio
incompatible del protocolo o de la API sube el major de todos.

## 1.2.0

Nada de esto obliga a cambiar código: un Proyecto que solo actualiza el SDK gana el checksum de
punta a punta y `purge()`, y todo lo demás funciona igual.

> **Requiere la API del File Service con estos cambios.** Contra una versión anterior de la API, las
> subidas que declaran `sha256` responden `400 validation` y `purge()` responde `not_found`.

### Checksum declarado (`sha256`)

- `POST /files` y la acción `create` del protocolo de subida aceptan un campo opcional `sha256`: el
  SHA-256 del contenido, 64 hex en minúscula (el mismo formato que `contentHash`). Otro formato →
  `400 validation`, sin crear nada.
- **Subida simple:** el checksum va firmado en el `PUT` (`x-amz-checksum-sha256` en
  `upload.headers`, que hay que mandar tal cual, como siempre). El storage rechaza con `400` un
  contenido distinto sin escribir nada, y los SDKs lo exponen como **`checksum_mismatch`**:
  - navegador: `UploadError` con `code: "checksum_mismatch"`;
  - servidor: `FileServiceError` / `Error` con `code` `checksum_mismatch` (Go: `CodeChecksumMismatch`).
  No se reintenta: el contenido no es el que se declaró (cambió el archivo entre el hash y la subida,
  o se corrompió). Lo normal es volver a subirlo.
- **Multipart:** el storage no puede verificar el archivo completo; lo verifica el servicio después
  de subir todo. Si no coincide, el file termina **`FAILED`**: `complete` con espera lanza
  `FileRejectedError` / `RejectedError` (`code: "failed"`), y llega el webhook `file.failed` con el
  motivo en `reason`.
- El `contentHash` lo sigue calculando siempre el servicio: el checksum declarado puede hacer fallar
  un file, nunca definir su hash.

Qué hace cada SDK sin cambiar código:

| | Calcula y declara el SHA-256 |
|---|---|
| Navegador (`upload()`) | En subidas simples (menos de 32 MB), con WebCrypto. Requiere contexto seguro (`https://` o `localhost`); sin WebCrypto sube sin checksum. |
| JS (`upload()`) | Siempre (`Uint8Array`, `ArrayBuffer`, `Blob` leído como stream). |
| Python (`upload()`) | Con `bytes`, una ruta o un archivo con seek. Un stream sin seek no se hashea. |
| Go (`Upload`) | Con un `Body` que implementa `io.ReaderAt` (`*os.File`, `*bytes.Reader`…). |
| PHP (`upload()`) | Con un string, un `SplFileInfo` o un stream con seek. |

El hash se calcula leyendo por bloques, sin cargar el archivo en memoria. `upload()` y
`createUpload()` aceptan además un `sha256` explícito (para streams de una sola pasada), que no se
recalcula; otro formato falla con `validation` sin llamar a la API. `handleUpload` valida el `sha256`
que manda el navegador y lo pasa a la API.

### Purga anticipada: `purge()`

- Ruta nueva `POST /files/{id}/purge` (scope `full`, `204`) y `purge(id)` en los cuatro SDKs (Go:
  `Purge`).
- Borra el file **en el acto y sin vuelta atrás**, esté o no en la papelera (por ejemplo, ante un
  pedido de borrado de datos personales): deja de listarse, no se puede restaurar ni descargar y su
  URL pública responde `404`. Se audita con el actor.
- Vale sobre un file `READY`, `AVAILABLE`, `FAILED` o `QUARANTINED`. Una subida en curso responde
  `invalid_state` (para eso está `delete()`); un file inexistente, de otro Proyecto o ya purgado,
  `not_found`. Un reintento cuya primera respuesta se perdió también puede recibir `not_found`:
  trátalo como éxito.
- **Plazos:** se borra el file, no el contenido. Si otro file del Proyecto comparte los mismos bytes
  (deduplicación), esos bytes siguen. Si no, el servicio los borra del storage en su ciclo de
  limpieza: unos **4 días** en total, contando la copia de seguridad del storage. La Cuota se libera
  recién entonces. La metadata del file (sin el contenido) puede seguir hasta unas **4 semanas** en
  las copias de seguridad de la base de datos, hasta que rotan.
- No emite webhook. Un evento que ya estaba encolado para el file (por ejemplo `file.available`) se
  entrega igual.

### `delete()` de una subida en curso la cancela

- `delete()` sobre un file `PENDING`/`UPLOADING` (una subida que todavía no se completó) la
  **cancela**: ya no se puede completar ni restaurar (`restore()` → `invalid_state`), y el servicio
  libera lo que tenía reservado de forma asíncrona, sin esperar al día de inactividad de antes.
- `delete()` sobre un file con contenido no cambia: va a la papelera y se restaura como siempre.
