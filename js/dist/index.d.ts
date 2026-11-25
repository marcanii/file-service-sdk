import { type CompletedPart, type CreatedUpload, type FileInfo, type FileStatus, type PartUrl, type Usage, type Visibility, type WebhookEvent } from "./types.js";
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
export declare class FileServiceError extends Error {
    /** Status HTTP (0 si no hubo respuesta). */
    readonly status: number;
    /**
     * `unauthorized` · `forbidden` · `project_disabled` · `not_found` · `validation` ·
     * `invalid_state` · `no_bytes` · `too_large` · `type_not_allowed` · `quota_exceeded` ·
     * `storage_full` · `rate_limited` · `internal` · `network` · `timeout`
     */
    readonly code: string;
    /**
     * `X-Request-ID` de la respuesta: incluilo al reportar un problema. `undefined` si no hubo
     * respuesta del File Service (`network`, `timeout`).
     */
    readonly requestId?: string | undefined;
    constructor(message: string, 
    /** Status HTTP (0 si no hubo respuesta). */
    status: number, 
    /**
     * `unauthorized` · `forbidden` · `project_disabled` · `not_found` · `validation` ·
     * `invalid_state` · `no_bytes` · `too_large` · `type_not_allowed` · `quota_exceeded` ·
     * `storage_full` · `rate_limited` · `internal` · `network` · `timeout`
     */
    code: string, 
    /**
     * `X-Request-ID` de la respuesta: incluilo al reportar un problema. `undefined` si no hubo
     * respuesta del File Service (`network`, `timeout`).
     */
    requestId?: string | undefined);
}
/** El archivo se subió pero el servicio lo rechazó al verificarlo (FAILED o QUARANTINED). */
export declare class FileRejectedError extends FileServiceError {
    readonly file: FileInfo;
    constructor(file: FileInfo);
}
/** La verificación del archivo no terminó dentro del tiempo de espera; sigue en curso en el servicio. */
export declare class VerificationTimeoutError extends FileServiceError {
    constructor(message: string);
}
/** La firma del webhook no es válida, o el evento es demasiado viejo. */
export declare class WebhookSignatureError extends Error {
    constructor(message: string);
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
    onComplete?: (file: FileInfo, ctx: {
        ownerRef: string;
        req: Request;
    }) => unknown | Promise<unknown>;
}
/**
 * Endpoint de subida listo para frameworks con Request/Response estándar: Next.js (App Router),
 * Hono, Remix, SvelteKit, Bun, Deno.
 *
 *   // app/api/files/route.ts
 *   export const { POST } = createUploadRoute(fs, { auth: async () => (await getSession())?.user.id });
 */
export declare function createUploadRoute(fs: FileService, opts: UploadRouteOptions): {
    POST: (req: Request) => Promise<Response>;
};
/** @internal Exportado para los tests de vectores compartidos. */
export declare function verifyUploadToken(apiKey: string, id: string, ownerRef: string, token: unknown, nowSec?: number): boolean;
/** @internal Exportado para los tests de vectores compartidos. */
export declare function makeUploadToken(apiKey: string, id: string, ownerRef: string, exp: number): string;
/**
 * Interpreta `Retry-After` (segundos o fecha HTTP) como ms de espera, con tope de 60 s.
 * `undefined` si falta, es inválido o ya venció (entonces se usa el backoff).
 * @internal Exportado para los tests.
 */
export declare function parseRetryAfterMs(value: string | null | undefined): number | undefined;
export declare class FileService {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly retries;
    private readonly fetchImpl;
    constructor(opts: FileServiceOptions);
    /**
     * Inicia una subida. Devuelve el `id` del archivo y las instrucciones que el navegador necesita
     * para subir los bytes directo al storage. Después hay que llamar a `complete()`.
     */
    createUpload(input: CreateUploadInput, opts?: CallOptions): Promise<CreatedUpload>;
    /** Subida multipart: firma las URLs de un lote de partes (hasta 100 por llamada). */
    signParts(id: string, partNumbers: number[], opts?: CallOptions): Promise<PartUrl[]>;
    /**
     * Cierra la subida: el servicio comprueba que los bytes estén en el storage y encola la
     * verificación. Es idempotente. Con `wait`, espera a que el archivo quede `AVAILABLE`.
     */
    complete(id: string, opts?: CompleteOptions): Promise<FileInfo>;
    /**
     * Metadatos del archivo y, si está disponible, una URL firmada de descarga de vida corta.
     * `inline: true` pide que el navegador lo muestre en vez de bajarlo (solo imágenes, video,
     * audio y PDF; el resto siempre baja como adjunto).
     */
    get(id: string, opts?: CallOptions & {
        inline?: boolean;
    }): Promise<FileInfo>;
    /** Atajo: la URL firmada de descarga. Lanza si el archivo no está disponible. */
    getDownloadUrl(id: string, opts?: CallOptions & {
        inline?: boolean;
    }): Promise<string>;
    /** Espera a que el worker termine de verificar el archivo. Lanza `FileRejectedError` si lo rechaza. */
    waitUntilAvailable(id: string, opts?: WaitOptions): Promise<FileInfo>;
    /** Lista los archivos del proyecto, del más nuevo al más viejo. No incluye URLs de descarga. */
    list(opts?: ListOptions): Promise<{
        files: FileInfo[];
        nextCursor?: string;
    }>;
    /** Recorre todas las páginas de `list()`. */
    listAll(opts?: Omit<ListOptions, "cursor">): AsyncGenerator<FileInfo>;
    /**
     * Uso del proyecto contra su Cuota y límites de su Política. Sirve con una key de solo lectura;
     * consultarlo antes de iniciar una subida evita un `quota_exceeded`.
     */
    usage(opts?: CallOptions): Promise<Usage>;
    /** Cambia la visibilidad y/o el nombre. Hacer público o privado un archivo es instantáneo. */
    update(id: string, changes: {
        visibility?: Visibility;
        name?: string;
    }, opts?: CallOptions): Promise<FileInfo>;
    /**
     * Manda el archivo a la papelera. Se puede recuperar con `restore()` durante el período de retención.
     * Sobre una subida en curso (sin completar), la cancela: ya no se puede restaurar ni completar.
     */
    delete(id: string, opts?: CallOptions): Promise<void>;
    /**
     * Purga anticipada: borra el archivo en el acto y sin vuelta atrás, esté o no en la papelera (p. ej.
     * un pedido de borrado de datos personales). No se lista, no se restaura, no se descarga y su URL
     * pública deja de responder. Si otro archivo del Proyecto comparte el contenido, ese contenido
     * sigue; si no, el servicio lo borra en su ciclo de limpieza. Una subida en curso → `invalid_state`
     * (usá `delete()`); inexistente o ya purgado → `not_found`.
     */
    purge(id: string, opts?: CallOptions): Promise<void>;
    /** Recupera un archivo de la papelera. Una subida cancelada no se restaura: `invalid_state`. */
    restore(id: string, opts?: CallOptions): Promise<FileInfo>;
    /**
     * Sube un archivo desde el servidor (por ejemplo, uno generado por el backend) y espera a que
     * quede disponible. Para archivos del usuario, preferí `createUpload()` + subida directa desde
     * el navegador: así los bytes no pasan por tu backend.
     */
    upload(input: UploadInput, opts?: CallOptions & {
        wait?: boolean | number | WaitOptions;
    }): Promise<FileInfo>;
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
    }): WebhookEvent;
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
    handleUpload(body: unknown, opts: HandleUploadOptions): Promise<UploadResult>;
    /** Token de subida (sdk/PROTOCOL.md): prueba sin estado de que `id` lo creó `ownerRef`. */
    private uploadToken;
    private checkUploadToken;
    /**
     * PUT de bytes a una URL firmada del storage. Devuelve el ETag. Cada intento tiene su timeout y
     * se reintenta ante red, timeout y 5xx (repetir un PUT al mismo objeto es idempotente; el Blob
     * se puede volver a leer).
     */
    private put;
    private request;
}
