/**
 * Helper de navegador. Lo normal es `upload(file, { endpoint })` contra el endpoint de tu backend
 * (`handleUpload` / `createUploadRoute`). `uploadFile` es el paso de bajo nivel: sube con las instrucciones que tu backend
 * obtuvo de `fs.createUpload()`. No usa ni conoce la API key.
 *
 *   const { id, upload } = await fetch("/api/files", { method: "POST", body: ... }).then(r => r.json());
 *   const { parts } = await uploadFile(file, upload, { onProgress: (p) => setProgress(p.percent) });
 *   await fetch(`/api/files/${id}/complete`, { method: "POST", body: JSON.stringify({ parts }) });
 */
import { hasChecksumHeader } from "./types.js";
export class UploadError extends Error {
    status;
    code;
    constructor(message, status, 
    /**
     * `code` estable del error (too_large, type_not_allowed, quarantined…), si el endpoint lo informó.
     * `checksum_mismatch`: el storage rechazó los bytes porque no coinciden con el Checksum declarado.
     */
    code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "UploadError";
    }
}
/**
 * Sube `file` al storage. En multipart devuelve las partes con sus ETags: hay que enviarlas al
 * backend para que llame a `fs.complete(id, { parts })`. En subida simple `parts` viene vacío.
 */
export async function uploadFile(file, upload, opts = {}) {
    const total = file.size;
    const report = (loaded) => opts.onProgress?.({ loaded, total, percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 100 });
    if (upload.mode === "simple") {
        if (!upload.url)
            throw new UploadError("instrucciones de subida inválidas: falta la URL", 0);
        const url = upload.url;
        try {
            await withRetries(opts, () => put(url, file, upload.headers, opts.signal, report));
        }
        catch (err) {
            // Con el Checksum declarado firmado en el PUT, el 400 del storage significa que los bytes no son
            // los que se declararon (cambió el archivo entre el hash y la subida, o se corrompió).
            if (err instanceof UploadError && err.status === 400 && hasChecksumHeader(upload.headers)) {
                throw new UploadError("el contenido no coincide con su SHA-256 declarado", 400, "checksum_mismatch");
            }
            throw err;
        }
        report(total);
        return { parts: [] };
    }
    if (!opts.signParts)
        throw new UploadError("la subida es multipart: falta la opción signParts", 0);
    const { partSize, partCount } = upload;
    if (!partSize || !partCount)
        throw new UploadError("instrucciones de subida inválidas: faltan las partes", 0);
    const parts = [];
    const loadedByPart = new Map();
    const progress = (n, loaded) => {
        loadedByPart.set(n, loaded);
        let sum = 0;
        for (const v of loadedByPart.values())
            sum += v;
        report(sum);
    };
    const pending = Array.from({ length: partCount }, (_, i) => i + 1);
    const batchSize = Math.min(Math.max(1, Math.floor(opts.signBatchSize ?? 10)), 100);
    const signed = new Map();
    // Firma `n` y, de paso, las siguientes de la cola que aún no tienen URL (look-ahead).
    const urlFor = (n) => {
        const hit = signed.get(n);
        if (hit)
            return hit;
        const batch = [n, ...pending.filter((p) => !signed.has(p)).slice(0, batchSize - 1)];
        const request = opts.signParts(batch).then((urls) => new Map(urls.map((u) => [u.partNumber, u.url])));
        for (const p of batch) {
            const url = request.then((m) => {
                const u = m.get(p);
                if (!u)
                    throw new UploadError(`el backend no devolvió la URL de la parte ${p}`, 0);
                return u;
            });
            url.catch(() => signed.get(p) === url && signed.delete(p));
            signed.set(p, url);
        }
        return signed.get(n);
    };
    const worker = async () => {
        for (;;) {
            const n = pending.shift();
            if (n === undefined)
                return;
            const chunk = file.slice((n - 1) * partSize, n * partSize);
            const putPart = async () => put(await urlFor(n), chunk, undefined, opts.signal, (loaded) => progress(n, loaded));
            let refreshes = 0;
            await withRetries(opts, async () => {
                let etag;
                try {
                    etag = await putPart();
                }
                catch (err) {
                    // 403 del storage: la URL firmada venció. Se pide una nueva (máx. 2 veces) sin abortar la subida.
                    // Ante red o 5xx se conserva la URL: no se gasta rate limit en re-firmar.
                    if (!(err instanceof UploadError && err.status === 403) || refreshes >= 2 || opts.signal?.aborted)
                        throw err;
                    refreshes++;
                    signed.delete(n);
                    etag = await putPart();
                }
                signed.delete(n);
                parts.push({ partNumber: n, etag });
                progress(n, chunk.size);
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, partCount) }, worker));
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return { parts };
}
/** Solo se reintentan los errores de red (status 0) y los 5xx: un 4xx se repetiría igual. */
function isRetryable(err) {
    return err instanceof UploadError && (err.status === 0 || err.status >= 500);
}
async function withRetries(opts, fn) {
    const retries = opts.retries ?? 3;
    for (let attempt = 0;; attempt++) {
        try {
            await fn();
            return;
        }
        catch (err) {
            if (opts.signal?.aborted || attempt >= retries || !isRetryable(err))
                throw err;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
    }
}
/**
 * Sube un archivo de punta a punta contra tu endpoint de subida (sdk/PROTOCOL.md) y devuelve el
 * archivo ya verificado. Funciona con cualquier backend que use el SDK del File Service (Node,
 * Python, Go, PHP).
 *
 *   const file = await upload(input.files[0], { endpoint: "/api/files", onProgress: (p) => setPct(p.percent) });
 */
export async function upload(file, opts) {
    const call = async (body) => {
        let res;
        try {
            res = await fetch(opts.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
                body: JSON.stringify(body),
                signal: opts.signal,
                credentials: opts.credentials ?? "same-origin",
            });
        }
        catch {
            throw new UploadError("no se pudo conectar con el endpoint de subida", 0);
        }
        const json = await res.json().catch(() => undefined);
        if (!res.ok) {
            throw new UploadError(json?.error?.message ?? `el endpoint de subida respondió HTTP ${res.status}`, res.status, json?.error?.code);
        }
        return json;
    };
    const name = opts.name ?? file.name ?? "archivo";
    const mimeType = file.type || "application/octet-stream";
    const sha256 = await declaredChecksum(file);
    const created = await call({ action: "create", name, mimeType, size: file.size, metadata: opts.metadata, sha256 });
    const { id, token } = created;
    const { parts } = await uploadFile(file, created.upload, {
        ...opts,
        signParts: async (partNumbers) => (await call({ action: "parts", id, token, partNumbers })).urls,
    });
    return call({ action: "complete", id, token, parts: parts.length ? parts : undefined });
}
/**
 * Umbral de multipart por defecto del servicio. El helper no lo conoce de antemano: por debajo asume
 * subida simple y calcula el Checksum declarado, que ahí garantiza el storage.
 */
const SIMPLE_UPLOAD_MAX = 32 * 1024 * 1024;
/**
 * Checksum declarado (ver PROTOCOL.md): SHA-256 con WebCrypto, solo para subidas simples (WebCrypto no
 * hashea por partes y en multipart el storage no lo verificaría). Sin WebCrypto (contexto no
 * seguro, http://) no se declara nada y la subida sigue igual.
 */
async function declaredChecksum(file) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || file.size >= SIMPLE_UPLOAD_MAX)
        return undefined;
    const digest = new Uint8Array(await subtle.digest("SHA-256", await file.arrayBuffer()));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** PUT con progreso (XMLHttpRequest: fetch no informa el avance de una subida). Devuelve el ETag. */
function put(url, body, headers, signal, onLoaded) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(new UploadError("subida cancelada", 0));
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        for (const [k, v] of Object.entries(headers ?? {}))
            xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => onLoaded(e.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve((xhr.getResponseHeader("ETag") ?? "").replace(/^"|"$/g, ""));
            }
            else {
                reject(new UploadError(`el storage rechazó la subida (HTTP ${xhr.status})`, xhr.status));
            }
        };
        xhr.onerror = () => reject(new UploadError("error de red durante la subida", 0));
        xhr.onabort = () => reject(new UploadError("subida cancelada", 0));
        const onAbort = () => xhr.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        // Sin esto cada PUT dejaría un listener vivo en el signal (fuga en subidas con miles de partes).
        xhr.onloadend = () => signal?.removeEventListener("abort", onAbort);
        xhr.send(body);
    });
}
