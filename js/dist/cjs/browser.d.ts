/**
 * Helper de navegador. Lo normal es `upload(file, { endpoint })` contra el endpoint de tu backend
 * (`handleUpload` / `createUploadRoute`). `uploadFile` es el paso de bajo nivel: sube con las instrucciones que tu backend
 * obtuvo de `fs.createUpload()`. No usa ni conoce la API key.
 *
 *   const { id, upload } = await fetch("/api/files", { method: "POST", body: ... }).then(r => r.json());
 *   const { parts } = await uploadFile(file, upload, { onProgress: (p) => setProgress(p.percent) });
 *   await fetch(`/api/files/${id}/complete`, { method: "POST", body: JSON.stringify({ parts }) });
 */
import { type CompletedPart, type PartUrl, type UploadInstructions } from "./types.js";
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
    /**
     * Partes cuya firma se pide en un solo `signParts` (default 10, máximo 100): cada pedido incluye la
     * parte que hace falta y las que siguen en la cola, así el backend no ve una ida por parte.
     */
    signBatchSize?: number;
    /** Partes subidas en paralelo en multipart (default 3). */
    concurrency?: number;
    /** Reintentos ante errores de red y 5xx, por parte en multipart y en la subida simple (default 3). */
    retries?: number;
}
export declare class UploadError extends Error {
    readonly status: number;
    /**
     * `code` estable del error (too_large, type_not_allowed, quarantined…), si el endpoint lo informó.
     * `checksum_mismatch`: el storage rechazó los bytes porque no coinciden con el Checksum declarado.
     */
    readonly code?: string | undefined;
    constructor(message: string, status: number, 
    /**
     * `code` estable del error (too_large, type_not_allowed, quarantined…), si el endpoint lo informó.
     * `checksum_mismatch`: el storage rechazó los bytes porque no coinciden con el Checksum declarado.
     */
    code?: string | undefined);
}
/**
 * Sube `file` al storage. En multipart devuelve las partes con sus ETags: hay que enviarlas al
 * backend para que llame a `fs.complete(id, { parts })`. En subida simple `parts` viene vacío.
 */
export declare function uploadFile(file: Blob, upload: UploadInstructions, opts?: UploadFileOptions): Promise<{
    parts: CompletedPart[];
}>;
export interface UploadOptions extends Omit<UploadFileOptions, "signParts"> {
    /** URL del endpoint de subida de TU backend (el que usa `handleUpload` / `createUploadRoute`). */
    endpoint: string;
    /** Headers extra para tu endpoint (ej. `Authorization` si tu app no usa cookies). */
    headers?: Record<string, string>;
    /** Metadata del cliente (tu backend puede pisarla). */
    metadata?: Record<string, unknown>;
    /** Nombre a usar en vez de `file.name`. */
    name?: string;
    /**
     * Modo de credenciales del `fetch` al endpoint (default `"same-origin"`). Con un endpoint en otro
     * origen que usa cookies hay que pasar `"include"` (y el endpoint debe responder CORS con credenciales).
     */
    credentials?: RequestCredentials;
}
/**
 * Sube un archivo de punta a punta contra tu endpoint de subida (sdk/PROTOCOL.md) y devuelve el
 * archivo ya verificado. Funciona con cualquier backend que use el SDK del File Service (Node,
 * Python, Go, PHP).
 *
 *   const file = await upload(input.files[0], { endpoint: "/api/files", onProgress: (p) => setPct(p.percent) });
 */
export declare function upload(file: File | Blob, opts: UploadOptions): Promise<UploadedFile>;
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
