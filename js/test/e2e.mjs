// Prueba del SDK contra un File Service real.
//   FS_KEY=fsk_test_... [FS_URL=http://localhost:8080] node test/e2e.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { FileService, FileRejectedError, FileServiceError } from "../dist/index.js";

const fs = new FileService({ apiKey: process.env.FS_KEY, baseUrl: process.env.FS_URL ?? "http://localhost:8080" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const step = (name) => console.log(`  ✓ ${name}`);

// 1. Flujo del navegador: el backend crea, "el navegador" hace el PUT, el backend completa.
const text = Buffer.from(`hola desde el sdk ${randomBytes(4).toString("hex")}\n`.repeat(20));
const created = await fs.createUpload({ name: "nota.txt", mimeType: "text/plain", size: text.length, ownerRef: "user_42", metadata: { origen: "sdk" } });
assert.equal(created.upload.mode, "simple");
const put = await fetch(created.upload.url, { method: "PUT", body: text, headers: created.upload.headers });
assert.equal(put.status, 200);
const file = await fs.complete(created.id, { wait: true, actor: "user_42" });
assert.equal(file.status, "AVAILABLE");
assert.equal(file.contentHash, sha(text));
assert.deepEqual(file.metadata, { origen: "sdk" });
step("createUpload + PUT directo + complete({ wait: true })");

// 2. Descarga.
const url = await fs.getDownloadUrl(created.id);
assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), text);
step("getDownloadUrl entrega los mismos bytes");

// 3. Subida desde el servidor en una sola llamada (simple y multipart).
const small = await fs.upload({ name: "reporte.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.7\nreporte generado\n"), ownerRef: "user_42" });
assert.equal(small.status, "AVAILABLE");
assert.equal(small.mimeType, "application/pdf");
step("upload() de un archivo generado en el servidor");

const big = randomBytes(33 << 20);
const bigFile = await fs.upload({ name: "grande.bin", mimeType: "application/octet-stream", data: big }, { wait: { timeoutMs: 120_000 } });
assert.equal(bigFile.contentHash, sha(big));
step("upload() multipart (33 MB)");

// 4. Listado por usuario.
const mine = [];
for await (const f of fs.listAll({ ownerRef: "user_42", limit: 1 })) mine.push(f.id);
assert.ok(mine.includes(created.id) && mine.includes(small.id));
step("listAll({ ownerRef }) pagina sola");

// 5. Público / privado.
const pub = await fs.update(created.id, { visibility: "public" });
assert.ok(pub.publicUrl);
const viaPublic = await fetch(pub.publicUrl);
assert.deepEqual(Buffer.from(await viaPublic.arrayBuffer()), text);
await fs.update(created.id, { visibility: "private" });
assert.equal((await fetch(pub.publicUrl)).status, 404);
step("update({ visibility }) prende y apaga la URL pública");

// 6. Papelera.
await fs.delete(created.id);
assert.ok((await fs.get(created.id)).deletedAt);
assert.equal((await fs.restore(created.id)).deletedAt, undefined);
step("delete + restore");

// 7. Rechazo: un ejecutable declarado como texto.
await assert.rejects(
  fs.upload({ name: "inofensivo.txt", mimeType: "text/plain", data: Buffer.concat([Buffer.from("MZ\x90\x00", "latin1"), Buffer.alloc(200)]) }),
  (err) => err instanceof FileRejectedError && err.code === "quarantined" && err.file.status === "QUARANTINED",
);
step("un ejecutable disfrazado lanza FileRejectedError (quarantined)");

// 8. Errores tipados.
await assert.rejects(fs.get("00000000-0000-7000-8000-000000000000"), (err) => err instanceof FileServiceError && err.code === "not_found" && err.status === 404);
await assert.rejects(new FileService({ apiKey: "fsk_test_mala", baseUrl: process.env.FS_URL ?? "http://localhost:8080" }).list(), (err) => err.code === "unauthorized");
step("errores tipados (not_found, unauthorized)");

// 9. Endpoint de subida (protocolo del navegador): handleUpload create → PUT → complete.
{
  const bytes = Buffer.from(`subida por protocolo ${randomBytes(8).toString("hex")}\n`.repeat(10));
  const c = await fs.handleUpload({ action: "create", name: "proto.txt", mimeType: "text/plain", size: bytes.length }, { ownerRef: "user_77" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const { id, token, upload } = c.body;
  assert.equal((await fetch(upload.url, { method: "PUT", body: bytes, headers: upload.headers })).status, 200);
  const robo = await fs.handleUpload({ action: "complete", id, token }, { ownerRef: "user_intruso" });
  assert.equal(robo.status, 403);
  const done = await fs.handleUpload({ action: "complete", id, token }, { ownerRef: "user_77" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.file.status, "AVAILABLE");
  assert.equal(done.file.ownerRef, "user_77");
  step("handleUpload: create + PUT + complete (y token ajeno → 403)");
}

console.log("\nSDK e2e OK");
