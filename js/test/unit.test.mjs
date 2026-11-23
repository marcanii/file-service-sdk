// Tests unitarios del SDK (sin red): firma de webhooks y mapeo de la API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { FileService, FileServiceError, WebhookSignatureError } from "../dist/index.js";

const secret = "whsec_test";
const payload = JSON.stringify({
  id: "evt_1",
  type: "file.available",
  data: { file: { id: "f1", project: "mi-app", status: "AVAILABLE", original_name: "a.txt", mime_type: "text/plain", size_bytes: 3, visibility: "private", metadata: {}, created_at: "2026-01-01T00:00:00Z" } },
});
const sign = (t, body = payload, key = secret) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.`).update(body).digest("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

test("verifyWebhook acepta una firma válida y devuelve el evento en camelCase", () => {
  const event = FileService.verifyWebhook({ payload, signature: sign(now()), secret });
  assert.equal(event.type, "file.available");
  assert.equal(event.data.file.name, "a.txt");
  assert.equal(event.data.file.mimeType, "text/plain");
});

test("verifyWebhook acepta el body como bytes", () => {
  const event = FileService.verifyWebhook({ payload: new TextEncoder().encode(payload), signature: sign(now()), secret });
  assert.equal(event.id, "evt_1");
});

test("verifyWebhook rechaza firma de otro secret, body alterado, firma vieja y header ausente", () => {
  const bad = [
    { payload, signature: sign(now(), payload, "whsec_otro"), secret },
    { payload: payload.replace("a.txt", "b.txt"), signature: sign(now()), secret },
    { payload, signature: sign(now() - 3600), secret },
    { payload, signature: undefined, secret },
    { payload, signature: "basura", secret },
  ];
  for (const args of bad) assert.throws(() => FileService.verifyWebhook(args), WebhookSignatureError);
});

test("los errores de la API llegan como FileServiceError con code y status", async () => {
  const fs = new FileService({
    apiKey: "fsk_test_x", baseUrl: "http://fs.test", retries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { code: "quota_exceeded", message: "cuota excedida" } }), { status: 507 }),
  });
  await assert.rejects(fs.createUpload({ name: "a", mimeType: "text/plain", size: 1 }), (err) => {
    assert.ok(err instanceof FileServiceError);
    assert.equal(err.code, "quota_exceeded");
    assert.equal(err.status, 507);
    return true;
  });
});

test("reintenta 5xx en operaciones idempotentes, pero no al crear", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ files: [] }), { status: 200 }));
  const fs = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: flaky });
  assert.deepEqual((await fs.list()).files, []);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(fs.createUpload({ name: "a", mimeType: "text/plain", size: 1 }));
  assert.equal(calls, 1);
});

test("envía la API key como Bearer y el actor en FS-Actor", async () => {
  let seen;
  const fs = new FileService({
    apiKey: "fsk_test_abc", baseUrl: "http://fs.test/",
    fetch: async (url, init) => ((seen = { url, init }), new Response(null, { status: 204 })),
  });
  await fs.delete("f1", { actor: "user_7" });
  assert.equal(seen.url, "http://fs.test/files/f1");
  assert.equal(seen.init.headers.Authorization, "Bearer fsk_test_abc");
  assert.equal(seen.init.headers["FS-Actor"], "user_7");
});

// ─── Vectores compartidos entre SDKs (sdk/testdata/vectors.json) ─────────────
import { readFileSync } from "node:fs";
import { createUploadRoute, makeUploadToken, verifyUploadToken } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../testdata/vectors.json", import.meta.url), "utf8"));

test("vectores: firma de webhook", () => {
  const w = vectors.webhook;
  const event = FileService.verifyWebhook({ payload: w.payload, signature: w.signature, secret: w.secret, toleranceSec: 1e10 });
  assert.equal(event.id, w.expected.id);
  assert.equal(event.type, w.expected.type);
  assert.equal(event.data.file.id, w.expected.fileId);
  assert.equal(event.data.file.name, w.expected.fileName);
  assert.equal(event.data.file.size, w.expected.size);
});

test("vectores: token de subida", () => {
  const { apiKey, cases } = vectors.uploadToken;
  for (const c of cases) {
    assert.equal(makeUploadToken(apiKey, c.id, c.ownerRef, c.exp), c.token);
    assert.equal(verifyUploadToken(apiKey, c.id, c.ownerRef, c.token, c.exp - 10), true);
    assert.equal(verifyUploadToken(apiKey, c.id, "otro_usuario", c.token, c.exp - 10), false, "otro owner");
    assert.equal(verifyUploadToken(apiKey, c.id, c.ownerRef, c.token, c.exp + 1), false, "vencido");
    assert.equal(verifyUploadToken("fsk_otra", c.id, c.ownerRef, c.token, c.exp - 10), false, "otra key");
  }
});

// ─── handleUpload / createUploadRoute ────────────────────────────────────────
const fakeApi = (handler) =>
  new FileService({
    apiKey: "fsk_test_x",
    baseUrl: "http://fs.test",
    retries: 0,
    fetch: async (url, init) => handler(new URL(url), init),
  });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("handleUpload: create devuelve id, token y upload; parts/complete exigen el token del mismo usuario", async () => {
  const calls = [];
  const fs = fakeApi((url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    if (url.pathname === "/files") {
      const b = JSON.parse(init.body);
      assert.equal(b.owner_ref, "user_1");
      assert.deepEqual(b.metadata, { album: "x", origen: "web" });
      return json(201, { id: "f1", status: "PENDING", upload: { mode: "multipart", part_size: 8, part_count: 2, expires_at: "t" } });
    }
    if (url.pathname === "/files/f1/parts") return json(200, { urls: [{ part_number: 1, url: "http://s/1" }] });
    if (url.pathname === "/files/f1/complete") return json(200, { id: "f1", status: "READY", original_name: "a", metadata: {} });
    if (url.pathname === "/files/f1") return json(200, { id: "f1", status: "AVAILABLE", original_name: "a", metadata: {} });
    return json(404, {});
  });

  const c = await fs.handleUpload(
    { action: "create", name: "a.bin", mimeType: "application/octet-stream", size: 16, metadata: { album: "x", origen: "hack" } },
    { ownerRef: "user_1", metadata: { origen: "web" } },
  );
  assert.equal(c.status, 200);
  assert.equal(c.body.upload.mode, "multipart");
  const { token } = c.body;

  const ajeno = await fs.handleUpload({ action: "parts", id: "f1", token, partNumbers: [1] }, { ownerRef: "user_2" });
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error.code, "forbidden");

  const p = await fs.handleUpload({ action: "parts", id: "f1", token, partNumbers: [1] }, { ownerRef: "user_1" });
  assert.deepEqual(p.body, { urls: [{ partNumber: 1, url: "http://s/1" }] });

  const done = await fs.handleUpload({ action: "complete", id: "f1", token, parts: [{ partNumber: 1, etag: "e" }] }, { ownerRef: "user_1" });
  assert.equal(done.status, 200);
  assert.equal(done.file.status, "AVAILABLE");
});

test("handleUpload: errores con el formato del protocolo", async () => {
  const fs = fakeApi(() => json(413, { error: { code: "too_large", message: "muy grande" } }));
  assert.equal((await fs.handleUpload({ action: "borrar" }, { ownerRef: "u" })).status, 400);
  assert.equal((await fs.handleUpload("no es json", { ownerRef: "u" })).status, 400);
  assert.equal((await fs.handleUpload({ action: "create" }, { ownerRef: "" })).status, 401);
  const r = await fs.handleUpload({ action: "create", name: "a", mimeType: "x/y", size: 1 }, { ownerRef: "u" });
  assert.deepEqual(r, { status: 413, body: { error: { code: "too_large", message: "muy grande" } } });
});

test("handleUpload: archivo rechazado → 422 quarantined", async () => {
  const fs = fakeApi((url) =>
    json(200, { id: "f1", status: url.pathname.endsWith("/complete") ? "READY" : "QUARANTINED", mime_type: "application/x-elf", metadata: {} }),
  );
  const token = makeUploadToken("fsk_test_x", "f1", "u", Math.floor(Date.now() / 1000) + 60);
  const r = await fs.handleUpload({ action: "complete", id: "f1", token }, { ownerRef: "u" });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "quarantined");
});

test("createUploadRoute: sin sesión → 401; con sesión delega en handleUpload", async () => {
  const fs = fakeApi(() => json(201, { id: "f1", status: "PENDING", upload: { mode: "simple", url: "http://s", expires_at: "t" } }));
  const route = createUploadRoute(fs, { auth: (req) => req.headers.get("x-user") });
  const req = (user) =>
    new Request("http://app/api/files", {
      method: "POST",
      headers: user ? { "x-user": user } : {},
      body: JSON.stringify({ action: "create", name: "a", mimeType: "text/plain", size: 1 }),
    });
  assert.equal((await route.POST(req())).status, 401);
  const res = await route.POST(req("user_1"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, "f1");
});

test("handleUpload: si la API rechaza la key del backend → 502 (no se confunde con usuario sin sesión)", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "project_disabled"]]) {
    const fs = fakeApi(() => json(status, { error: { code, message: "x" } }));
    const r = await fs.handleUpload({ action: "create", name: "a", mimeType: "x/y", size: 1 }, { ownerRef: "u" });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, code);
  }
});
