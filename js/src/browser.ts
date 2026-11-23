/**
 * Helper de navegador. Lo normal es `upload(file, { endpoint })` contra el endpoint de tu backend
 * (`handleUpload` / `createUploadRoute`). `uploadFile` es el paso de bajo nivel: sube con las instrucciones que tu backend
 * obtuvo de `fs.createUpload()`. No usa ni conoce la API key.
 *
 *   const { id, upload } = await fetch("/api/files", { method: "POST", body: ... }).then(r => r.json());
 *   const { parts } = await uploadFile(file, upload, { onProgress: (p) => setProgress(p.percent) });
 *   await fetch(`/api/files/${id}/complete`, { method: "POST", body: JSON.stringify({ parts }) });
 */
import type { CompletedPart, PartUrl, UploadInstructions } from "./types.js";

export type { CompletedPart, PartUrl, UploadInstructions } from "./types.js";

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0 a 100. */
  percent: number;
}

export interface UploadFileOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /**
   * Requerido en subidas multipart: pide a TU backend las URLs firmadas de un lote de partes
   * (el backend las obtiene con `fs.signParts(id, partNumbers)`).
   */
  signParts?: (partNumbers: number[]) => Promise<PartUrl[]>;
  /** Partes subidas en paralelo en multipart (default 3). */
  concurrency?: number;
  /** Reintentos por parte ante fallas de red (default 3). */
  retries?: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `code` estable del error (too_large, type_not_allowed, quarantined…), si el endpoint lo informó. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Sube `file` al storage. En multipart devuelve las partes con sus ETags: hay que enviarlas al
 * backend para que llame a `fs.complete(id, { parts })`. En subida simple `parts` viene vacío.
 */
export async function uploadFile(
  file: Blob,
  upload: UploadInstructions,
  opts: UploadFileOptions = {},
): Promise<{ parts: CompletedPart[] }> {
  const total = file.size;
  const report = (loaded: number) =>
    opts.onProgress?.({ loaded, total, percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 100 });

  if (upload.mode === "simple") {
    if (!upload.url) throw new UploadError("instrucciones de subida inválidas: falta la URL", 0);
    await put(upload.url, file, upload.headers, opts.signal, report);
    report(total);
    return { parts: [] };
  }

  if (!opts.signParts) throw new UploadError("la subida es multipart: falta la opción signParts", 0);
  const { partSize, partCount } = upload;
  if (!partSize || !partCount) throw new UploadError("instrucciones de subida inválidas: faltan las partes", 0);

  const parts: CompletedPart[] = [];
  const loadedByPart = new Map<number, number>();
  const progress = (n: number, loaded: number) => {
    loadedByPart.set(n, loaded);
    let sum = 0;
    for (const v of loadedByPart.values()) sum += v;
    report(sum);
  };

  const pending = Array.from({ length: partCount }, (_, i) => i + 1);
  const worker = async () => {
    for (;;) {
      const n = pending.shift();
      if (n === undefined) return;
      const chunk = file.slice((n - 1) * partSize, n * partSize);
      const retries = opts.retries ?? 3;
      for (let attempt = 0; ; attempt++) {
        try {
          // La URL se firma justo antes de usarla: no caduca aunque la subida sea lenta.
          const [signed] = await opts.signParts!([n]);
          const etag = await put(signed.url, chunk, undefined, opts.signal, (loaded) => progress(n, loaded));
          parts.push({ partNumber: n, etag });
          progress(n, chunk.size);
          break;
        } catch (err) {
          if (opts.signal?.aborted || attempt >= retries) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, partCount) }, worker));
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return { parts };
}

export interface UploadOptions extends Omit<UploadFileOptions, "signParts"> {
  /** URL del endpoint de subida de TU backend (el que usa `handleUpload` / `createUploadRoute`). */
  endpoint: string;
  /** Headers extra para tu endpoint (ej. `Authorization` si tu app no usa cookies). */
  headers?: Record<string, string>;
  /** Metadata del cliente (tu backend puede pisarla). */
  metadata?: Record<string, unknown>;
  /** Nombre a usar en vez de `file.name`. */
  name?: string;
}

/**
 * Sube un archivo de punta a punta contra tu endpoint de subida (sdk/PROTOCOL.md) y devuelve el
 * archivo ya verificado. Funciona con cualquier backend que use el SDK del File Service (Node,
 * Python, Go, PHP).
 *
 *   const file = await upload(input.files[0], { endpoint: "/api/files", onProgress: (p) => setPct(p.percent) });
 */
export async function upload(file: File | Blob, opts: UploadOptions): Promise<UploadedFile> {
  const call = async (body: Record<string, unknown>): Promise<any> => {
    let res: Response;
    try {
      res = await fetch(opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: opts.signal,
        credentials: "same-origin",
      });
    } catch {
      throw new UploadError("no se pudo conectar con el endpoint de subida", 0);
    }
    const json = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new UploadError(json?.error?.message ?? `el endpoint de subida respondió HTTP ${res.status}`, res.status, json?.error?.code);
    }
    return json;
  };

  const name = opts.name ?? (file as File).name ?? "archivo";
  const mimeType = file.type || "application/octet-stream";
  const created = await call({ action: "create", name, mimeType, size: file.size, metadata: opts.metadata });
  const { id, token } = created;

  const { parts } = await uploadFile(file, created.upload, {
    ...opts,
    signParts: async (partNumbers) => (await call({ action: "parts", id, token, partNumbers })).urls,
  });
  return call({ action: "complete", id, token, parts: parts.length ? parts : undefined });
}

/** El archivo tal como lo devuelve el endpoint de subida (`FileInfo` del SDK). */
export interface UploadedFile {
  id: string;
  status: string;
  name: string;
  mimeType: string;
  size: number;
  visibility: "private" | "public";
  publicUrl?: string;
  ownerRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  [key: string]: unknown;
}

/** PUT con progreso (XMLHttpRequest: fetch no informa el avance de una subida). Devuelve el ETag. */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  onLoaded: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadError("subida cancelada", 0));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.getResponseHeader("ETag") ?? "").replace(/^"|"$/g, ""));
      } else {
        reject(new UploadError(`el storage rechazó la subida (HTTP ${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new UploadError("error de red durante la subida", 0));
    xhr.onabort = () => reject(new UploadError("subida cancelada", 0));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
