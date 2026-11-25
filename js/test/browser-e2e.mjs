// Prueba de upload() (helper de navegador) contra un endpoint real montado con createUploadRoute.
// XMLHttpRequest no existe en Node: se simula con fetch (sin progreso intermedio).
//   FS_KEY=fsk_test_... [FS_URL=http://localhost:8080] node test/browser-e2e.mjs
// Con FS_ENDPOINT=<url> usa un endpoint externo (ej. un backend Python/Go/PHP con handleUpload que
// autentica con el header x-user): prueba la compatibilidad del protocolo entre lenguajes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { FileService, createUploadRoute } from "../dist/index.js";
import { upload, UploadError } from "../dist/browser.js";

globalThis.XMLHttpRequest = class {
  upload = {};
  open(method, url) { Object.assign(this, { method, url, headers: {} }); }
  setRequestHeader(k, v) { this.headers[k] = v; }
  getResponseHeader(k) { return this.res.headers.get(k); }
  abort() {}
  async send(body) {
    try {
      this.res = await fetch(this.url, { method: this.method, headers: this.headers, body });
      this.status = this.res.status;
      this.upload.onprogress?.({ loaded: body.size });
      this.onload();
    } catch { this.onerror(); }
  }
};

const fs = new FileService({ apiKey: process.env.FS_KEY, baseUrl: process.env.FS_URL ?? "http://localhost:8080" });
let saved;
const route = createUploadRoute(fs, {
  auth: (req) => req.headers.get("x-user"),
  onComplete: (file) => { saved = file; },
});
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await route.POST(new Request(`http://app${req.url}`, { method: "POST", headers: req.headers, body: Buffer.concat(chunks) }));
  res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
});
await new Promise((ok) => server.listen(0, ok));
const external = process.env.FS_ENDPOINT;
const endpoint = external ?? `http://localhost:${server.address().port}/api/files`;
const step = (name) => console.log(`  ✓ ${name}`);

try {
  const small = new Blob([`hola ${randomBytes(8).toString("hex")}\n`.repeat(50)], { type: "text/plain" });
  let last = 0;
  const f1 = await upload(small, { endpoint, name: "nota.txt", headers: { "x-user": "user_9" }, onProgress: (p) => (last = p.percent) });
  assert.equal(f1.status, "AVAILABLE");
  assert.equal(f1.ownerRef, "user_9");
  if (!external) assert.equal(saved.id, f1.id);
  assert.equal(last, 100);
  step("upload() simple → AVAILABLE, onComplete recibe el file");

  const big = new Blob([randomBytes(34 * 1024 * 1024)], { type: "application/octet-stream" });
  const f2 = await upload(big, { endpoint, name: "grande.bin", headers: { "x-user": "user_9" } });
  assert.equal(f2.status, "AVAILABLE");
  assert.equal(f2.size, big.size);
  step("upload() multipart (34 MB) → AVAILABLE");

  const hashed = new Blob([`con checksum ${randomBytes(8).toString("hex")}\n`.repeat(20)], { type: "text/plain" });
  const f3 = await upload(hashed, { endpoint, name: "hash.txt", headers: { "x-user": "user_9" } });
  assert.equal(f3.status, "AVAILABLE");
  assert.equal(f3.contentHash, createHash("sha256").update(Buffer.from(await hashed.arrayBuffer())).digest("hex"));
  // Un digest que no es el del contenido simula un archivo que cambió entre el hash y la subida.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (alg) => digest(alg, new TextEncoder().encode("otro contenido"));
  try {
    await assert.rejects(upload(hashed, { endpoint, name: "hash.txt", headers: { "x-user": "user_9" } }),
      (e) => e instanceof UploadError && e.status === 400 && e.code === "checksum_mismatch");
  } finally {
    crypto.subtle.digest = digest;
  }
  step("upload() simple declara el sha256; contenido distinto → UploadError checksum_mismatch");

  await assert.rejects(upload(small, { endpoint, name: "x.txt" }), (e) => e instanceof UploadError && e.status === 401 && e.code === "unauthorized");
  step("sin sesión → UploadError 401 unauthorized");

  console.log("\nbrowser e2e OK");
} finally {
  server.close();
}
