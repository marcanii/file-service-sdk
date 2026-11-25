/**
 * SDK de servidor del File Service de ntropix.
 *
 * Se usa SOLO en el backend del proyecto: la API key nunca debe llegar al navegador. El navegador
 * recibe únicamente las instrucciones de subida (URLs firmadas) — ver `@ntropix/file-service/browser`.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  hasChecksumHeader,
  toFileInfo,
  toUploadInstructions,
  type CompletedPart,
  type CreatedUpload,
  type FileInfo,
  type FileStatus,
  type PartUrl,
  type Usage,
  type Visibility,
  type WebhookEvent,
} from "./types.js";

export type * from "./types.js";

export interface FileServiceOptions {
  /** API key del proyecto (`fsk_live_...` / `fsk_test_...`). */
  apiKey: string;
  /** URL de la API, ej. `https://files.ntropix.dev`. */
  baseUrl: string;
  /** Tiempo máximo por request en ms (default 30 000). */
  timeoutMs?: number;
  /** Reintentos ante errores de red, 429 y 5xx en operaciones seguras de repetir (default 2). */
  retries?: number;
  /** Implementación de fetch (default: la global). */
  fetch?: typeof fetch;
}

/** Opciones comunes a las operaciones sobre archivos. */
export interface CallOptions {
  /** Id del usuario final que origina la acción. Solo queda en la auditoría. */
  actor?: string;
  signal?: AbortSignal;
}

export interface CreateUploadInput {
  /** Nombre original del archivo (sin rutas). */
  name: string;
  /** Tipo declarado. El servicio verifica después el tipo real del contenido. */
  mimeType: string;
  /** Tamaño exacto en bytes. El storage rechaza una subida de otro tamaño. */
  size: number;
  /** Id del usuario final en tu sistema: permite listar y auditar por usuario. */
  ownerRef?: string;
  /** `private` (default) o `public` (URL estable para quien tenga el link). */
  visibility?: Visibility;
  /** Datos propios del proyecto (JSON, hasta 16 KB). */
  metadata?: Record<string, unknown>;
  /**
   * Checksum declarado: SHA-256 del contenido, 64 hex en minúscula. Opcional. En subida simple el
   * storage rechaza un contenido distinto (`checksum_mismatch`); en multipart, el file termina
   * `FAILED`. `upload()` lo calcula solo si no se pasa. Otro formato → `validation`, sin llamar a la API.
   */
  sha256?: string;
}

export interface WaitOptions {
  /** Tiempo máximo de espera en ms (default 30 000). */
  timeoutMs?: number;
  /** Intervalo inicial entre consultas en ms (default 500; crece hasta 3 000). */
  intervalMs?: number;
  signal?: AbortSignal;
  /** Id del usuario final: queda en la auditoría de las consultas de la espera. */
  actor?: string;
}

export interface CompleteOptions extends CallOptions {
  /** Requerido en subidas multipart: las partes con sus ETags. */
  parts?: CompletedPart[];
  /**
   * Esperar a que el archivo quede verificado antes de devolver. Si el archivo termina en FAILED o
   * QUARANTINED, lanza `FileRejectedError`.
   *
   * - `false`, `undefined`, `0`, un número negativo o `{ timeoutMs <= 0 }`: sin espera; devuelve
   *   apenas el servicio cierra la subida (archivo en `READY`, sin `download`).
   * - `true`: espera hasta 30 s (defaults de `waitUntilAvailable`).
   * - número positivo: tiempo máximo de espera en ms.
   * - `WaitOptions`: espera con esas opciones.
   */
  wait?: boolean | number | WaitOptions;
}

export interface ListOptions {
  ownerRef?: string;
  status?: FileStatus;
  /** `true` lista la papelera; por defecto lista los archivos vivos. */
  trashed?: boolean;
  /** `nextCursor` de la página anterior. */
  cursor?: string;
  /** Tamaño de página (default 50, máximo 200). */
  limit?: number;
  signal?: AbortSignal;
}

export interface UploadInput extends CreateUploadInput {
  /** Contenido a subir desde el servidor (por ejemplo un PDF generado por el backend). */
  data: Uint8Array | ArrayBuffer | Blob;
}

/** Error devuelto por la API. `code` es estable y sirve para decidir qué hacer. */
export class FileServiceError extends Error {
  constructor(
    message: string,
    /** Status HTTP (0 si no hubo respuesta). */
    readonly status: number,
    /**
     * `unauthorized` · `forbidden` · `project_disabled` · `not_found` · `validation` ·
     * `invalid_state` · `no_bytes` · `too_large` · `type_not_allowed` · `quota_exceeded` ·
     * `storage_full` · `rate_limited` · `internal` · `network` · `timeout`
     */
    readonly code: string,
    /**
     * `X-Request-ID` de la respuesta: incluilo al reportar un problema. `undefined` si no hubo
     * respuesta del File Service (`network`, `timeout`).
     */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}

/** El archivo se subió pero el servicio lo rechazó al verificarlo (FAILED o QUARANTINED). */
export class FileRejectedError extends FileServiceError {
  constructor(readonly file: FileInfo) {
    super(
      file.status === "QUARANTINED"
        ? `el archivo quedó en cuarentena: su tipo real (${file.mimeType}) no está permitido`
        : "el archivo no pasó la verificación (corrupto o incompleto)",
      422,
      file.status === "QUARANTINED" ? "quarantined" : "failed",
    );
    this.name = "FileRejectedError";
  }
}

/** La verificación del archivo no terminó dentro del tiempo de espera; sigue en curso en el servicio. */
export class VerificationTimeoutError extends FileServiceError {
  constructor(message: string) {
    super(message, 0, "timeout");
    this.name = "VerificationTimeoutError";
  }
}

/** La firma del webhook no es válida, o el evento es demasiado viejo. */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface HandleUploadOptions {
  /** Id del usuario autenticado por TU backend. Obligatorio: sin él responde 401. */
  ownerRef: string;
  /** Visibilidad que fija el backend (el navegador no la elige). Default `private`. */
  visibility?: Visibility;
  /** Metadata propia del backend; pisa las claves que mande el navegador. */
  metadata?: Record<string, unknown>;
  /** Cuánto esperar la verificación en `complete` (default 30 000 ms). */
  waitTimeoutMs?: number;
}

/** Respuesta lista para devolver al navegador. `file` solo viene en un `complete` exitoso. */
export interface UploadResult {
  status: number;
  body: unknown;
  file?: FileInfo;
}

export interface UploadRouteOptions extends Omit<HandleUploadOptions, "ownerRef"> {
  /** Devuelve el id del usuario autenticado, o null/undefined si no hay sesión (→ 401). */
  auth: (req: Request) => Promise<string | null | undefined> | string | null | undefined;
  /** Se llama con el archivo ya verificado; lo que devuelva (si no es undefined) va al navegador. */
  onComplete?: (file: FileInfo, ctx: { ownerRef: string; req: Request }) => unknown | Promise<unknown>;
}

/**
 * Endpoint de subida listo para frameworks con Request/Response estándar: Next.js (App Router),
 * Hono, Remix, SvelteKit, Bun, Deno.
 *
 *   // app/api/files/route.ts
 *   export const { POST } = createUploadRoute(fs, { auth: async () => (await getSession())?.user.id });
 */
export function createUploadRoute(fs: FileService, opts: UploadRouteOptions): { POST: (req: Request) => Promise<Response> } {
  return {
    async POST(req: Request) {
      let ownerRef: string | null | undefined;
      try {
        ownerRef = await opts.auth(req);
      } catch {
        ownerRef = undefined;
      }
      if (!ownerRef) return Response.json({ error: { code: "unauthorized", message: "no autenticado" } }, { status: 401 });
      const body = await req.json().catch(() => undefined);
      const { auth: _a, onComplete, ...handleOpts } = opts;
      const r = await fs.handleUpload(body, { ...handleOpts, ownerRef });
      if (r.file && onComplete) {
        const custom = await onComplete(r.file, { ownerRef, req });
        if (custom !== undefined) return Response.json(custom, { status: 200 });
      }
      return Response.json(r.body, { status: r.status });
    },
  };
}

function uploadError(status: number, code: string, message: string): UploadResult {
  return { status, body: { error: { code, message } } };
}

function parseBody(body: unknown): any {
  if (typeof body === "string" || body instanceof Uint8Array) {
    try {
      body = JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return isPlainObject(body) ? body : undefined;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Formato canónico (sdk/PROTOCOL.md): Unix = 1 a 12 dígitos ASCII sin ceros a la izquierda; MAC = 64 hex en minúscula.
const CANONICAL_UNIX_RE = /^[1-9][0-9]{0,11}$/;
const LOWER_HEX_SHA256_RE = /^[0-9a-f]{64}$/;
/** SHA-256 hex del contenido; un Blob se lee como stream, sin cargarlo entero. */
async function sha256Of(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const h = createHash("sha256");
  if (data instanceof Blob) {
    for await (const chunk of data.stream() as unknown as AsyncIterable<Uint8Array>) h.update(chunk);
  } else {
    h.update(data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  return h.digest("hex");
}

/** Checksum declarado: mismo formato canónico que el Content Hash (ver PROTOCOL.md). */
function isDeclaredSha256(v: unknown): v is string {
  return typeof v === "string" && LOWER_HEX_SHA256_RE.test(v);
}
const UPLOAD_TOKEN_RE = /^([1-9][0-9]{0,11})\.([0-9a-f]{64})$/;

function uploadTokenSig(apiKey: string, id: string, ownerRef: string, exp: number): string {
  return createHmac("sha256", apiKey).update(`fs-upload-token.v1:${id}:${ownerRef}:${exp}`).digest("hex");
}

/** @internal Exportado para los tests de vectores compartidos. */
export function verifyUploadToken(apiKey: string, id: string, ownerRef: string, token: unknown, nowSec = Date.now() / 1000): boolean {
  if (typeof token !== "string") return false;
  const m = UPLOAD_TOKEN_RE.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= nowSec) return false;
  const given = Buffer.from(m[2], "hex");
  const expected = Buffer.from(uploadTokenSig(apiKey, id, ownerRef, exp), "hex");
  return timingSafeEqual(given, expected);
}

/** @internal Exportado para los tests de vectores compartidos. */
export function makeUploadToken(apiKey: string, id: string, ownerRef: string, exp: number): string {
  return `${exp}.${uploadTokenSig(apiKey, id, ownerRef, exp)}`;
}

/** User-Agent de todos los requests a la API (misma forma en los 4 SDKs). Mantener = package.json. */
const USER_AGENT = "ntropix-file-service-js/1.1.0";

/** Tope de espera por `Retry-After`, igual en los 4 SDKs. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Interpreta `Retry-After` (segundos o fecha HTTP) como ms de espera, con tope de 60 s.
 * `undefined` si falta, es inválido o ya venció (entonces se usa el backoff).
 * @internal Exportado para los tests.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = at - Date.now();
  }
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

const backoffMs = (attempt: number) => 250 * 2 ** (attempt - 1);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export class FileService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FileServiceOptions) {
    if (!opts?.apiKey) throw new Error("FileService: falta apiKey");
    if (!opts?.baseUrl) throw new Error("FileService: falta baseUrl");
    if (typeof window !== "undefined" && typeof (window as any).document !== "undefined") {
      throw new Error("FileService: este SDK es solo para servidor — la API key no debe llegar al navegador");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /**
   * Inicia una subida. Devuelve el `id` del archivo y las instrucciones que el navegador necesita
   * para subir los bytes directo al storage. Después hay que llamar a `complete()`.
   */
  async createUpload(input: CreateUploadInput, opts: CallOptions = {}): Promise<CreatedUpload> {
    if (input.sha256 !== undefined && !isDeclaredSha256(input.sha256)) {
      throw new FileServiceError("sha256 debe ser 64 hex en minúscula", 0, "validation");
    }
    const raw = await this.request("POST", "/files", {
      retryRateLimit: true,
      body: {
        original_name: input.name,
        mime_type: input.mimeType,
        size_bytes: input.size,
        owner_ref: input.ownerRef,
        visibility: input.visibility,
        metadata: input.metadata,
        sha256: input.sha256,
      },
      ...opts,
    });
    return { id: raw.id, status: raw.status, upload: toUploadInstructions(raw.upload) };
  }

  /** Subida multipart: firma las URLs de un lote de partes (hasta 100 por llamada). */
  async signParts(id: string, partNumbers: number[], opts: CallOptions = {}): Promise<PartUrl[]> {
    const raw = await this.request("POST", `/files/${id}/parts`, { body: { part_numbers: partNumbers }, idempotent: true, ...opts });
    return raw.urls.map((u: any) => ({ partNumber: u.part_number, url: u.url }));
  }

  /**
   * Cierra la subida: el servicio comprueba que los bytes estén en el storage y encola la
   * verificación. Es idempotente. Con `wait`, espera a que el archivo quede `AVAILABLE`.
   */
  async complete(id: string, opts: CompleteOptions = {}): Promise<FileInfo> {
    const body = opts.parts?.length
      ? { parts: opts.parts.map((p) => ({ part_number: p.partNumber, etag: p.etag.replace(/^"|"$/g, "") })) }
      : undefined;
    const file = toFileInfo(await this.request("POST", `/files/${id}/complete`, { body, idempotent: true, ...opts }));
    const wait = opts.wait;
    if (!wait) return file;
    const waitOpts: WaitOptions = typeof wait === "number" ? { timeoutMs: wait } : wait === true ? {} : wait;
    if (waitOpts.timeoutMs !== undefined && !(waitOpts.timeoutMs > 0)) return file;
    return this.waitUntilAvailable(id, { ...waitOpts, signal: opts.signal, actor: opts.actor });
  }

  /**
   * Metadatos del archivo y, si está disponible, una URL firmada de descarga de vida corta.
   * `inline: true` pide que el navegador lo muestre en vez de bajarlo (solo imágenes, video,
   * audio y PDF; el resto siempre baja como adjunto).
   */
  async get(id: string, opts: CallOptions & { inline?: boolean } = {}): Promise<FileInfo> {
    const query = opts.inline ? "?disposition=inline" : "";
    return toFileInfo(await this.request("GET", `/files/${id}${query}`, { idempotent: true, ...opts }));
  }

  /** Atajo: la URL firmada de descarga. Lanza si el archivo no está disponible. */
  async getDownloadUrl(id: string, opts: CallOptions & { inline?: boolean } = {}): Promise<string> {
    const file = await this.get(id, opts);
    if (!file.download) {
      throw new FileServiceError(`el archivo no está disponible para descarga (estado ${file.status})`, 409, "invalid_state");
    }
    return file.download.url;
  }

  /** Espera a que el worker termine de verificar el archivo. Lanza `FileRejectedError` si lo rechaza. */
  async waitUntilAvailable(id: string, opts: WaitOptions = {}): Promise<FileInfo> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let interval = opts.intervalMs ?? 500;
    for (;;) {
      const file = await this.get(id, { signal: opts.signal, actor: opts.actor });
      if (file.status === "AVAILABLE") return file;
      if (file.status === "FAILED" || file.status === "QUARANTINED") throw new FileRejectedError(file);
      if (Date.now() + interval > deadline) {
        throw new VerificationTimeoutError(
          `el archivo sigue en ${file.status}: la verificación no terminó a tiempo (sigue en curso; consultá más tarde o usá el webhook)`,
        );
      }
      await sleep(interval, opts.signal);
      interval = Math.min(interval * 1.5, 3_000);
    }
  }

  /** Lista los archivos del proyecto, del más nuevo al más viejo. No incluye URLs de descarga. */
  async list(opts: ListOptions = {}): Promise<{ files: FileInfo[]; nextCursor?: string }> {
    const q = new URLSearchParams();
    if (opts.ownerRef) q.set("owner_ref", opts.ownerRef);
    if (opts.status) q.set("status", opts.status);
    if (opts.trashed) q.set("trashed", "true");
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const raw = await this.request("GET", `/files${qs ? `?${qs}` : ""}`, { idempotent: true, signal: opts.signal });
    return { files: raw.files.map(toFileInfo), nextCursor: raw.next_cursor || undefined };
  }

  /** Recorre todas las páginas de `list()`. */
  async *listAll(opts: Omit<ListOptions, "cursor"> = {}): AsyncGenerator<FileInfo> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...opts, cursor });
      yield* page.files;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Uso del proyecto contra su Cuota y límites de su Política. Sirve con una key de solo lectura;
   * consultarlo antes de iniciar una subida evita un `quota_exceeded`.
   */
  async usage(opts: CallOptions = {}): Promise<Usage> {
    const raw = await this.request("GET", "/usage", { idempotent: true, ...opts });
    return {
      usedBytes: raw.used_bytes,
      quotaBytes: raw.quota_bytes,
      fileCount: raw.file_count,
      maxFileSize: raw.max_file_size,
      allowedMimeTypes: raw.allowed_mime_types ?? [],
    };
  }

  /** Cambia la visibilidad y/o el nombre. Hacer público o privado un archivo es instantáneo. */
  async update(id: string, changes: { visibility?: Visibility; name?: string }, opts: CallOptions = {}): Promise<FileInfo> {
    return toFileInfo(
      await this.request("PATCH", `/files/${id}`, {
        body: { visibility: changes.visibility, original_name: changes.name },
        idempotent: true,
        ...opts,
      }),
    );
  }

  /**
   * Manda el archivo a la papelera. Se puede recuperar con `restore()` durante el período de retención.
   * Sobre una subida en curso (sin completar), la cancela: ya no se puede restaurar ni completar.
   */
  async delete(id: string, opts: CallOptions = {}): Promise<void> {
    await this.request("DELETE", `/files/${id}`, { idempotent: true, ...opts });
  }

  /**
   * Purga anticipada: borra el archivo en el acto y sin vuelta atrás, esté o no en la papelera (p. ej.
   * un pedido de borrado de datos personales). No se lista, no se restaura, no se descarga y su URL
   * pública deja de responder. Si otro archivo del Proyecto comparte el contenido, ese contenido
   * sigue; si no, el servicio lo borra en su ciclo de limpieza. Una subida en curso → `invalid_state`
   * (usá `delete()`); inexistente o ya purgado → `not_found`.
   */
  async purge(id: string, opts: CallOptions = {}): Promise<void> {
    await this.request("POST", `/files/${id}/purge`, { idempotent: true, ...opts });
  }

  /** Recupera un archivo de la papelera. Una subida cancelada no se restaura: `invalid_state`. */
  async restore(id: string, opts: CallOptions = {}): Promise<FileInfo> {
    return toFileInfo(await this.request("POST", `/files/${id}/restore`, { idempotent: true, ...opts }));
  }

  /**
   * Sube un archivo desde el servidor (por ejemplo, uno generado por el backend) y espera a que
   * quede disponible. Para archivos del usuario, preferí `createUpload()` + subida directa desde
   * el navegador: así los bytes no pasan por tu backend.
   */
  async upload(input: UploadInput, opts: CallOptions & { wait?: boolean | number | WaitOptions } = {}): Promise<FileInfo> {
    const blob = input.data instanceof Blob ? input.data : new Blob([input.data as BlobPart]);
    const { data: _omit, ...meta } = input;
    // Todas las entradas se pueden releer: sin sha256 explícito, se calcula (createUpload lo valida).
    const sha256 = meta.sha256 ?? (await sha256Of(input.data));
    const created = await this.createUpload({ ...meta, size: blob.size, sha256 }, opts);
    const up = created.upload;
    let parts: CompletedPart[] | undefined;

    if (up.mode === "simple") {
      await this.put(up.url!, blob, up.headers, opts.signal);
    } else {
      parts = [];
      const numbers = Array.from({ length: up.partCount! }, (_, i) => i + 1);
      for (let i = 0; i < numbers.length; i += 100) {
        for (const p of await this.signParts(created.id, numbers.slice(i, i + 100), opts)) {
          const chunk = blob.slice((p.partNumber - 1) * up.partSize!, p.partNumber * up.partSize!);
          const etag = await this.put(p.url, chunk, undefined, opts.signal);
          parts.push({ partNumber: p.partNumber, etag });
        }
      }
    }
    return this.complete(created.id, { ...opts, parts, wait: opts.wait ?? true });
  }

  /**
   * Verifica la firma de un webhook y devuelve el evento. Pasá el body CRUDO (texto o bytes, sin
   * parsear) y el header `FS-Signature`. Lanza `WebhookSignatureError` si la firma no coincide o
   * el evento tiene más de `toleranceSec` segundos (default 300): protege contra reenvíos.
   */
  static verifyWebhook(args: {
    payload: string | Uint8Array;
    signature: string | null | undefined;
    secret: string;
    toleranceSec?: number;
  }): WebhookEvent {
    const { payload, signature, secret } = args;
    if (!signature) throw new WebhookSignatureError("falta el header FS-Signature");
    let tRaw: string | undefined;
    const candidates: Buffer[] = [];
    for (const kv of signature.split(",")) {
      const field = kv.trim();
      const eq = field.indexOf("=");
      if (eq < 0) continue;
      const k = field.slice(0, eq);
      const v = field.slice(eq + 1);
      if (k === "t") {
        if (tRaw !== undefined) throw new WebhookSignatureError("FS-Signature con formato inválido");
        tRaw = v;
      } else if (k === "v1" && LOWER_HEX_SHA256_RE.test(v)) {
        candidates.push(Buffer.from(v, "hex"));
      }
    }
    if (tRaw === undefined || !CANONICAL_UNIX_RE.test(tRaw) || candidates.length === 0) {
      throw new WebhookSignatureError("FS-Signature con formato inválido");
    }
    const t = Number(tRaw);

    const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
    const expected = createHmac("sha256", secret).update(`${tRaw}.`).update(body).digest();
    if (!candidates.some((given) => timingSafeEqual(given, expected))) {
      throw new WebhookSignatureError("la firma del webhook no coincide");
    }
    if (Math.abs(Date.now() / 1000 - t) > (args.toleranceSec ?? 300)) {
      throw new WebhookSignatureError("el evento es demasiado viejo");
    }
    const raw = JSON.parse(body.toString("utf8"));
    return { id: raw.id, type: raw.type, data: { file: toFileInfo(raw.data.file) } };
  }

  /**
   * Implementa el endpoint de subida que usa `upload()` de `@ntropix/file-service/browser`
   * (protocolo en sdk/PROTOCOL.md). Tu backend autentica al usuario y le pasa su id como
   * `ownerRef`; el resto (crear, firmar partes, completar y esperar la verificación) lo resuelve
   * esto. Nunca lanza: los errores vuelven como `{ status, body: { error } }`.
   *
   *   const r = await fs.handleUpload(await req.json(), { ownerRef: user.id });
   *   if (r.file) await guardarEnMiBase(r.file);   // solo en el `complete` exitoso
   *   return Response.json(r.body, { status: r.status });
   */
  async handleUpload(body: unknown, opts: HandleUploadOptions): Promise<UploadResult> {
    try {
      if (!opts?.ownerRef) return uploadError(401, "unauthorized", "falta el usuario autenticado (ownerRef)");
      const b = parseBody(body);
      if (!b) return uploadError(400, "validation", "body JSON inválido");
      const actor = opts.ownerRef;

      switch (b.action) {
        case "create": {
          if (typeof b.name !== "string" || typeof b.mimeType !== "string" || typeof b.size !== "number") {
            return uploadError(400, "validation", "create requiere name, mimeType y size");
          }
          if (b.sha256 != null && !isDeclaredSha256(b.sha256)) {
            return uploadError(400, "validation", "sha256 debe ser 64 hex en minúscula");
          }
          const clientMeta = isPlainObject(b.metadata) ? b.metadata : {};
          const created = await this.createUpload(
            {
              name: b.name,
              mimeType: b.mimeType,
              size: b.size,
              ownerRef: opts.ownerRef,
              visibility: opts.visibility,
              metadata: { ...clientMeta, ...(opts.metadata ?? {}) },
              sha256: b.sha256 ?? undefined,
            },
            { actor },
          );
          const token = this.uploadToken(created.id, opts.ownerRef);
          return { status: 200, body: { id: created.id, token, upload: created.upload } };
        }
        case "parts": {
          if (typeof b.id !== "string" || !b.id) return uploadError(400, "validation", "falta id");
          if (!this.checkUploadToken(b, opts.ownerRef)) return uploadError(403, "forbidden", "token de subida inválido o vencido");
          const nums = b.partNumbers;
          if (!Array.isArray(nums) || nums.length === 0 || nums.length > 100 || !nums.every(Number.isInteger)) {
            return uploadError(400, "validation", "partNumbers debe ser una lista de 1 a 100 enteros");
          }
          return { status: 200, body: { urls: await this.signParts(b.id, nums, { actor }) } };
        }
        case "complete": {
          if (typeof b.id !== "string" || !b.id) return uploadError(400, "validation", "falta id");
          if (!this.checkUploadToken(b, opts.ownerRef)) return uploadError(403, "forbidden", "token de subida inválido o vencido");
          const parts = Array.isArray(b.parts)
            ? b.parts.map((p: any) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag ?? "") }))
            : undefined;
          // `complete` sin espera: un timeout o fallo de red aquí es un 502 (lo resuelve el catch
          // de abajo). Solo el timeout de la verificación devuelve el file como está.
          await this.complete(b.id, { parts, actor });
          let file: FileInfo;
          try {
            file = await this.waitUntilAvailable(b.id, { timeoutMs: opts.waitTimeoutMs ?? 30_000, actor });
          } catch (err) {
            // La verificación sigue en curso: se devuelve el file como está (READY).
            if (err instanceof VerificationTimeoutError) {
              file = await this.get(b.id, { actor });
            } else throw err;
          }
          return { status: 200, body: file, file };
        }
        default:
          return uploadError(400, "validation", "action desconocida: se espera create, parts o complete");
      }
    } catch (err) {
      if (err instanceof FileServiceError) {
        // 401/403 de la API = la key del BACKEND fue rechazada: no es culpa del usuario (→ 502).
        const status = err.status === 0 || err.status === 401 || err.status === 403 ? 502 : err.status;
        const res = uploadError(status, err.code, err.message);
        return err instanceof FileRejectedError ? { ...res, file: err.file } : res;
      }
      return uploadError(500, "internal", "error interno del endpoint de subida");
    }
  }

  /** Token de subida (sdk/PROTOCOL.md): prueba sin estado de que `id` lo creó `ownerRef`. */
  private uploadToken(id: string, ownerRef: string, exp = Math.floor(Date.now() / 1000) + 86_400): string {
    return `${exp}.${uploadTokenSig(this.apiKey, id, ownerRef, exp)}`;
  }

  private checkUploadToken(b: any, ownerRef: string): boolean {
    return typeof b.id === "string" && verifyUploadToken(this.apiKey, b.id, ownerRef, b.token);
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  /**
   * PUT de bytes a una URL firmada del storage. Devuelve el ETag. Cada intento tiene su timeout y
   * se reintenta ante red, timeout y 5xx (repetir un PUT al mismo objeto es idempotente; el Blob
   * se puede volver a leer).
   */
  private async put(url: string, body: Blob, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const attempts = this.retries + 1;
    let lastError: FileServiceError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(url, { method: "PUT", body, headers, signal: attemptSignal });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = timeout.aborted
          ? new FileServiceError(`el storage no respondió en ${this.timeoutMs} ms`, 0, "timeout")
          : new FileServiceError(`no se pudo subir al storage: ${(err as Error).message}`, 0, "network");
      }
      if (res) {
        if (res.ok) return (res.headers.get("etag") ?? "").replace(/^"|"$/g, "");
        lastError =
          res.status === 400 && hasChecksumHeader(headers)
            ? // Con el Checksum declarado firmado en el PUT, un 400 es contenido distinto del declarado.
              new FileServiceError("el contenido no coincide con su SHA-256 declarado", 400, "checksum_mismatch")
            : new FileServiceError(`el storage rechazó la subida (HTTP ${res.status})`, res.status, "storage_rejected");
        if (res.status < 500) throw lastError;
      }
      if (attempt < attempts) await sleep(backoffMs(attempt), signal);
    }
    throw lastError!;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; actor?: string; signal?: AbortSignal; idempotent?: boolean; retryRateLimit?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (opts.actor) headers["FS-Actor"] = opts.actor;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Solo se reintenta lo que es seguro repetir: crear un archivo dos veces dejaría uno huérfano.
    // Excepción: un 429 se rechaza antes de procesar, así que repetirlo nunca duplica (retryRateLimit).
    const attempts = opts.idempotent || opts.retryRateLimit ? this.retries + 1 : 1;
    let lastError: FileServiceError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl + path, { method, headers, body, signal });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        lastError = timeout.aborted
          ? new FileServiceError(`el File Service no respondió en ${this.timeoutMs} ms`, 0, "timeout")
          : new FileServiceError(`no se pudo conectar con el File Service: ${(err as Error).message}`, 0, "network");
        if (!opts.idempotent) throw lastError;
        if (attempt < attempts) await sleep(backoffMs(attempt), opts.signal);
        continue;
      }

      if (res.status === 204) return undefined;
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (res.ok) return json;

      lastError = new FileServiceError(
        json?.error?.message ?? `respuesta inesperada del File Service (HTTP ${res.status})`,
        res.status,
        json?.error?.code ?? "internal",
        res.headers.get("x-request-id") ?? undefined,
      );
      const retryable = res.status === 429 || (opts.idempotent === true && res.status >= 500);
      if (!retryable || attempt === attempts) throw lastError;
      await sleep(parseRetryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt), opts.signal);
    }
    throw lastError!;
  }
}
