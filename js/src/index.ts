/**
 * SDK de servidor del File Service de ntropix.
 *
 * Se usa SOLO en el backend del proyecto: la API key nunca debe llegar al navegador. El navegador
 * recibe únicamente las instrucciones de subida (URLs firmadas) — ver `@ntropix/file-service/browser`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  toFileInfo,
  toUploadInstructions,
  type CompletedPart,
  type CreatedUpload,
  type FileInfo,
  type FileStatus,
  type PartUrl,
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
}

export interface WaitOptions {
  /** Tiempo máximo de espera en ms (default 30 000). */
  timeoutMs?: number;
  /** Intervalo inicial entre consultas en ms (default 500; crece hasta 3 000). */
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface CompleteOptions extends CallOptions {
  /** Requerido en subidas multipart: las partes con sus ETags. */
  parts?: CompletedPart[];
  /**
   * Esperar a que el archivo quede verificado antes de devolver. Con `true` usa los defaults de
   * `waitUntilAvailable`. Si el archivo termina en FAILED o QUARANTINED, lanza `FileRejectedError`.
   */
  wait?: boolean | WaitOptions;
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

function uploadTokenSig(apiKey: string, id: string, ownerRef: string, exp: number): string {
  return createHmac("sha256", apiKey).update(`fs-upload-token.v1:${id}:${ownerRef}:${exp}`).digest("hex");
}

/** @internal Exportado para los tests de vectores compartidos. */
export function verifyUploadToken(apiKey: string, id: string, ownerRef: string, token: unknown, nowSec = Date.now() / 1000): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  const exp = Number(token.slice(0, dot));
  if (dot < 1 || !Number.isInteger(exp) || exp <= nowSec) return false;
  const given = Buffer.from(token.slice(dot + 1), "hex");
  const expected = Buffer.from(uploadTokenSig(apiKey, id, ownerRef, exp), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** @internal Exportado para los tests de vectores compartidos. */
export function makeUploadToken(apiKey: string, id: string, ownerRef: string, exp: number): string {
  return `${exp}.${uploadTokenSig(apiKey, id, ownerRef, exp)}`;
}

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
    const raw = await this.request("POST", "/files", {
      body: {
        original_name: input.name,
        mime_type: input.mimeType,
        size_bytes: input.size,
        owner_ref: input.ownerRef,
        visibility: input.visibility,
        metadata: input.metadata,
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
    if (!opts.wait) return file;
    return this.waitUntilAvailable(id, { signal: opts.signal, ...(opts.wait === true ? {} : opts.wait) });
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
      const file = await this.get(id, { signal: opts.signal });
      if (file.status === "AVAILABLE") return file;
      if (file.status === "FAILED" || file.status === "QUARANTINED") throw new FileRejectedError(file);
      if (Date.now() + interval > deadline) {
        throw new FileServiceError(
          `el archivo sigue en ${file.status}: la verificación no terminó a tiempo (sigue en curso; consultá más tarde o usá el webhook)`,
          0,
          "timeout",
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

  /** Manda el archivo a la papelera. Se puede recuperar con `restore()` durante el período de retención. */
  async delete(id: string, opts: CallOptions = {}): Promise<void> {
    await this.request("DELETE", `/files/${id}`, { idempotent: true, ...opts });
  }

  /** Recupera un archivo de la papelera. */
  async restore(id: string, opts: CallOptions = {}): Promise<FileInfo> {
    return toFileInfo(await this.request("POST", `/files/${id}/restore`, { idempotent: true, ...opts }));
  }

  /**
   * Sube un archivo desde el servidor (por ejemplo, uno generado por el backend) y espera a que
   * quede disponible. Para archivos del usuario, preferí `createUpload()` + subida directa desde
   * el navegador: así los bytes no pasan por tu backend.
   */
  async upload(input: UploadInput, opts: CallOptions & { wait?: boolean | WaitOptions } = {}): Promise<FileInfo> {
    const blob = input.data instanceof Blob ? input.data : new Blob([input.data as BlobPart]);
    const { data: _omit, ...meta } = input;
    const created = await this.createUpload({ ...meta, size: blob.size }, opts);
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
    const fields = new Map(signature.split(",").map((kv) => kv.split("=", 2) as [string, string]));
    const t = Number(fields.get("t"));
    const v1 = fields.get("v1");
    if (!Number.isFinite(t) || !v1) throw new WebhookSignatureError("FS-Signature con formato inválido");

    const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
    const expected = createHmac("sha256", secret).update(`${t}.`).update(body).digest();
    const given = Buffer.from(v1, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
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
          const clientMeta = isPlainObject(b.metadata) ? b.metadata : {};
          const created = await this.createUpload(
            {
              name: b.name,
              mimeType: b.mimeType,
              size: b.size,
              ownerRef: opts.ownerRef,
              visibility: opts.visibility,
              metadata: { ...clientMeta, ...(opts.metadata ?? {}) },
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
          let file: FileInfo;
          try {
            file = await this.complete(b.id, { parts, actor, wait: { timeoutMs: opts.waitTimeoutMs ?? 30_000 } });
          } catch (err) {
            // La verificación sigue en curso: se devuelve el file como está (READY).
            if (err instanceof FileServiceError && err.code === "timeout" && !(err instanceof FileRejectedError)) {
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
        return uploadError(status, err.code, err.message);
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

  /** PUT de bytes a una URL firmada del storage. Devuelve el ETag. */
  private async put(url: string, body: Blob, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "PUT", body, headers, signal });
    } catch (err) {
      throw new FileServiceError(`no se pudo subir al storage: ${(err as Error).message}`, 0, "network");
    }
    if (!res.ok) throw new FileServiceError(`el storage rechazó la subida (HTTP ${res.status})`, res.status, "storage_rejected");
    return (res.headers.get("etag") ?? "").replace(/^"|"$/g, "");
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; actor?: string; signal?: AbortSignal; idempotent?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (opts.actor) headers["FS-Actor"] = opts.actor;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Solo se reintenta lo que es seguro repetir: crear un archivo dos veces dejaría uno huérfano.
    const attempts = opts.idempotent ? this.retries + 1 : 1;
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
        if (attempt < attempts) await sleep(250 * 2 ** (attempt - 1), opts.signal);
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
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === attempts) throw lastError;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** (attempt - 1), opts.signal);
    }
    throw lastError!;
  }
}
