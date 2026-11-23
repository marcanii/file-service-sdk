/** Estados del ciclo de vida de un archivo. Solo `AVAILABLE` es descargable. */
export type FileStatus = "PENDING" | "UPLOADING" | "READY" | "AVAILABLE" | "FAILED" | "QUARANTINED";
export type Visibility = "private" | "public";
/** Un archivo tal como lo ve el proyecto. */
export interface FileInfo {
    id: string;
    /** Slug del proyecto dueño. */
    project: string;
    status: FileStatus;
    name: string;
    /** Tipo declarado al subir; una vez `AVAILABLE`, el tipo REAL detectado por el servicio. */
    mimeType: string;
    size: number;
    /** SHA-256 del contenido (cuando ya fue verificado). */
    contentHash?: string;
    /** Id del usuario final en tu sistema, si lo informaste al subir. */
    ownerRef?: string;
    visibility: Visibility;
    /** URL estable para archivos públicos y disponibles: se puede usar directo en un `<img src>`. */
    publicUrl?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    /** Presente si el archivo está en la papelera. */
    deletedAt?: string;
    /** URL firmada de descarga de vida corta. Solo viene en `get()` y si el archivo está disponible. */
    download?: {
        url: string;
        expiresAt: string;
    };
}
/** Instrucciones para que el navegador suba los bytes directo al storage. */
export interface UploadInstructions {
    mode: "simple" | "multipart";
    /** simple: URL firmada para un único PUT. */
    url?: string;
    /** simple: headers que el PUT debe llevar. */
    headers?: Record<string, string>;
    /** multipart: tamaño de cada parte (la última puede ser menor). */
    partSize?: number;
    /** multipart: cantidad de partes. */
    partCount?: number;
    expiresAt: string;
}
export interface CreatedUpload {
    id: string;
    status: FileStatus;
    upload: UploadInstructions;
}
/** Una parte ya subida: su número y el ETag que devolvió el storage. */
export interface CompletedPart {
    partNumber: number;
    etag: string;
}
export interface PartUrl {
    partNumber: number;
    url: string;
}
export type WebhookEventType = "file.available" | "file.failed" | "file.quarantined";
/** Evento que el File Service envía al webhook del proyecto. */
export interface WebhookEvent {
    /** Id único del evento: usalo para descartar duplicados (la entrega es at-least-once). */
    id: string;
    type: WebhookEventType;
    data: {
        file: FileInfo;
    };
}
/** snake_case de la API → camelCase del SDK. */
export declare function toFileInfo(raw: any): FileInfo;
export declare function toUploadInstructions(raw: any): UploadInstructions;
