// Tests unitarios del SDK (sin red): firma de webhooks y mapeo de la API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { FileService, FileServiceError, WebhookSignatureError, parseRetryAfterMs } from "../dist/index.js";

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

test("los errores de la API exponen el X-Request-ID; los de red no tienen", async () => {
  const fs = new FileService({
    apiKey: "fsk_test_x", baseUrl: "http://fs.test", retries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { code: "internal", message: "error interno" } }),
      { status: 500, headers: { "x-request-id": "01a20e8f-5540-7791-a25a-9e0e76d34ceb" } }),
  });
  await assert.rejects(fs.get("f1"), (err) => {
    assert.equal(err.requestId, "01a20e8f-5540-7791-a25a-9e0e76d34ceb");
    return true;
  });

  const offline = new FileService({
    apiKey: "fsk_test_x", baseUrl: "http://fs.test", retries: 0,
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(offline.get("f1"), (err) => {
    assert.equal(err.code, "network");
    assert.equal(err.requestId, undefined);
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

test("envía User-Agent ntropix-file-service-js/<versión> igual al package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  let seen;
  const fs = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: async (_u, init) => ((seen = init), new Response(null, { status: 204 })) });
  await fs.delete("f1");
  assert.equal(seen.headers["User-Agent"], `ntropix-file-service-js/${pkg.version}`);
});

test("parseRetryAfterMs: segundos, fecha HTTP, tope de 60 s e inválidos", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("3600"), 60_000);
  assert.equal(parseRetryAfterMs("0"), undefined);
  assert.equal(parseRetryAfterMs("-1"), undefined);
  assert.equal(parseRetryAfterMs("abc"), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
  const ms = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
  assert.ok(ms > 3000 && ms <= 5000);
  assert.equal(parseRetryAfterMs(new Date(Date.now() + 3_600_000).toUTCString()), 60_000);
  assert.equal(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString()), undefined);
});

test("createUpload reintenta 429 respetando Retry-After, pero no 5xx ni red", async () => {
  let calls = 0;
  const created = { id: "f1", status: "PENDING", upload: { mode: "simple", url: "u", expires_at: "x" } };
  const fs = new FileService({
    apiKey: "k", baseUrl: "http://fs.test",
    fetch: async () => (++calls < 2
      ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
      : new Response(JSON.stringify(created), { status: 201 })),
  });
  const t0 = Date.now();
  assert.equal((await fs.createUpload({ name: "a", mimeType: "text/plain", size: 1 })).id, "f1");
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 900);

  calls = 0;
  const down = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: async () => (++calls, Promise.reject(new Error("boom"))) });
  await assert.rejects(down.createUpload({ name: "a", mimeType: "text/plain", size: 1 }));
  assert.equal(calls, 1);
});

const simpleUpload = { id: "f1", status: "PENDING", upload: { mode: "simple", url: "http://st.test/put", expires_at: "x" } };
const fileJson = (status) => ({ id: "f1", project: "p", status, original_name: "a", mime_type: "text/plain", size_bytes: 1, visibility: "private", metadata: {}, created_at: "x" });

test("upload: el PUT al storage reintenta 5xx y red, y manda el mismo cuerpo", async () => {
  let puts = 0;
  const sizes = [];
  const fetchImpl = async (url, init) => {
    if (init.method === "PUT") {
      sizes.push(init.body.size);
      if (++puts === 1) throw new Error("reset");
      if (puts === 2) return new Response("", { status: 503 });
      return new Response("", { status: 200, headers: { etag: '"e1"' } });
    }
    if (url.endsWith("/files")) return new Response(JSON.stringify(simpleUpload), { status: 201 });
    return new Response(JSON.stringify(fileJson("READY")), { status: 200 });
  };
  const fs = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: fetchImpl });
  await fs.upload({ name: "a", mimeType: "text/plain", size: 1, data: new Uint8Array([1, 2, 3]) }, { wait: false });
  assert.equal(puts, 3);
  assert.deepEqual(sizes, [3, 3, 3]);
});

test("upload: el PUT al storage tiene timeout por intento y no reintenta 4xx", async () => {
  let puts = 0;
  const hang = async (url, init) => {
    if (init.method !== "PUT") return new Response(JSON.stringify(simpleUpload), { status: 201 });
    puts++;
    // AbortSignal.timeout no mantiene vivo el event loop: en el test lo retenemos nosotros.
    const keepAlive = setInterval(() => {}, 1000);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => (clearInterval(keepAlive), reject(init.signal.reason))));
  };
  const fs = new FileService({ apiKey: "k", baseUrl: "http://fs.test", timeoutMs: 50, retries: 1, fetch: hang });
  await assert.rejects(fs.upload({ name: "a", mimeType: "text/plain", size: 1, data: new Uint8Array(1) }), (e) => e.code === "timeout");
  assert.equal(puts, 2);

  puts = 0;
  const denied = async (url, init) => (init.method === "PUT" ? (puts++, new Response("", { status: 403 })) : new Response(JSON.stringify(simpleUpload), { status: 201 }));
  const fs2 = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: denied });
  await assert.rejects(fs2.upload({ name: "a", mimeType: "text/plain", size: 1, data: new Uint8Array(1) }), (e) => e.code === "storage_rejected");
  assert.equal(puts, 1);
});

test("verifyWebhook acepta varios v1 (rotación de secret) si alguno coincide", () => {
  const t = now();
  const good = sign(t).split("v1=")[1];
  const other = "a".repeat(64);
  for (const sig of [`t=${t},v1=${other},v1=${good}`, `t=${t},v1=${good},v1=${other}`]) {
    assert.equal(FileService.verifyWebhook({ payload, signature: sig, secret }).id, "evt_1");
  }
  assert.throws(() => FileService.verifyWebhook({ payload, signature: `t=${t},v1=${other},v1=${"b".repeat(64)}`, secret }), WebhookSignatureError);
});

test("complete: wait false/0/negativo no espera; true, número (ms) y objeto sí", async () => {
  for (const [wait, expectGets] of [[undefined, 0], [false, 0], [0, 0], [-5, 0], [{ timeoutMs: 0 }, 0], [true, 1], [5000, 1], [{ timeoutMs: 5000 }, 1]]) {
    let gets = 0;
    const fetchImpl = async (_u, init) => {
      if (init.method === "GET") gets++;
      return new Response(JSON.stringify(fileJson(init.method === "GET" ? "AVAILABLE" : "READY")), { status: 200 });
    };
    const fs = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: fetchImpl });
    const f = await fs.complete("f1", { wait });
    assert.equal(gets, expectGets, `wait=${JSON.stringify(wait)}`);
    assert.equal(f.status, expectGets ? "AVAILABLE" : "READY");
  }
});

// ─── Vectores compartidos entre SDKs (sdk/testdata/vectors.json) ─────────────
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

test("vectores: file.failed expone reason", () => {
  const w = vectors.webhookFailed;
  const event = FileService.verifyWebhook({ payload: w.payload, signature: w.signature, secret: w.secret, toleranceSec: 1e10 });
  assert.equal(event.type, w.expected.type);
  assert.equal(event.data.file.id, w.expected.fileId);
  assert.equal(event.data.file.status, w.expected.status);
  assert.equal(event.data.file.reason, w.expected.reason);
  assert.equal(event.data.file.publicUrl, undefined);
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

test("vectores negativos: token de subida", () => {
  const { apiKey, negative } = vectors.uploadToken;
  assert.ok(negative.length > 0);
  for (const c of negative) {
    assert.equal(verifyUploadToken(apiKey, c.id, c.ownerRef, c.token, c.now), false, c.name);
  }
});

test("vectores negativos: firma de webhook", () => {
  const w = vectors.webhook;
  const messages = { missing: /falta/, malformed: /formato inválido/, mismatch: /no coincide/, expired: /viejo/ };
  const realNow = Date.now;
  try {
    for (const c of vectors.webhookNegative.rejected) {
      Date.now = () => c.now * 1000;
      assert.throws(
        () => FileService.verifyWebhook({ payload: w.payload, signature: c.signature, secret: w.secret }),
        (err) => err instanceof WebhookSignatureError && messages[c.reason].test(err.message),
        c.name,
      );
    }
    for (const c of vectors.webhookNegative.accepted) {
      Date.now = () => c.now * 1000;
      const ev = FileService.verifyWebhook({ payload: w.payload, signature: c.signature, secret: w.secret });
      assert.equal(ev.id, w.expected.id, c.name);
    }
  } finally {
    Date.now = realNow;
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
  assert.equal(r.file.status, "QUARANTINED");
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

test("handleUpload: timeout de red en complete → 502, no 200 con el file en PENDING", async () => {
  const fs = fakeApi((url) => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  });
  const token = makeUploadToken("fsk_test_x", "f1", "u", Math.floor(Date.now() / 1000) + 60);
  const r = await fs.handleUpload({ action: "complete", id: "f1", token }, { ownerRef: "u" });
  assert.equal(r.status, 502);
  assert.equal(r.file, undefined);
});

test("handleUpload: timeout de verificación → 200 con el file como está; el actor viaja en la espera", async () => {
  const actors = [];
  const fs = fakeApi((url, init) => {
    actors.push(new Headers(init.headers).get("FS-Actor"));
    return json(200, { id: "f1", status: "READY", metadata: {} });
  });
  const token = makeUploadToken("fsk_test_x", "f1", "u", Math.floor(Date.now() / 1000) + 60);
  const r = await fs.handleUpload({ action: "complete", id: "f1", token }, { ownerRef: "u", waitTimeoutMs: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.file.status, "READY");
  assert.ok(actors.length >= 2 && actors.every((a) => a === "u"), `actores: ${actors}`);
});

// ─── Helper de navegador (XMLHttpRequest simulado) ───────────────────────────

function installFakeXhr(statuses) {
  const calls = [];
  globalThis.XMLHttpRequest = class {
    constructor() {
      this.upload = {};
      this.status = 0;
      calls.push(this);
    }
    open(_m, url) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader() { return '"etag1"'; }
    send() {
      const s = statuses.shift() ?? 200;
      queueMicrotask(() => {
        if (s === 0) this.onerror?.();
        else { this.status = s; this.onload?.(); }
        this.onloadend?.();
      });
    }
    abort() { this.onabort?.(); this.onloadend?.(); }
  };
  return calls;
}

test("uploadFile: quita el listener de abort al terminar cada PUT", async () => {
  const { uploadFile } = await import("../dist/browser.js");
  installFakeXhr([]);
  const ctl = new AbortController();
  let added = 0, removed = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const rem = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = (t, f, o) => (t === "abort" && added++, add(t, f, o));
  ctl.signal.removeEventListener = (t, f, o) => (t === "abort" && removed++, rem(t, f, o));
  await uploadFile(new Blob(["abcdef"]), { mode: "multipart", partSize: 2, partCount: 3 }, {
    signal: ctl.signal,
    signParts: async (ns) => ns.map((n) => ({ partNumber: n, url: `http://s/${n}` })),
  });
  assert.equal(added, 3);
  assert.equal(removed, 3);
});

test("uploadFile: no reintenta 400/403 pero sí 5xx y red, también en subida simple", async () => {
  const { uploadFile, UploadError } = await import("../dist/browser.js");
  const simple = { mode: "simple", url: "http://s/x" };
  const blob = new Blob(["abc"]);

  for (const status of [400, 403]) {
    const calls = installFakeXhr([status, 200]);
    await assert.rejects(uploadFile(blob, simple, { retries: 3 }), (e) => e instanceof UploadError && e.status === status);
    assert.equal(calls.length, 1);
  }

  const calls = installFakeXhr([503, 0, 200]);
  await uploadFile(blob, simple, { retries: 3 });
  assert.equal(calls.length, 3);
});

test("upload: credentials configurable, same-origin por defecto", async () => {
  const { upload } = await import("../dist/browser.js");
  const seen = [];
  globalThis.fetch = async (_u, init) => {
    seen.push(init.credentials);
    return { ok: true, json: async () => ({ id: "f", token: "t", upload: { mode: "simple", url: "http://s/x" }, status: "AVAILABLE" }) };
  };
  installFakeXhr([]);
  await upload(new Blob(["a"]), { endpoint: "http://e/files" });
  await upload(new Blob(["a"]), { endpoint: "http://e/files", credentials: "include" });
  assert.deepEqual(seen, ["same-origin", "same-origin", "include", "include"]);
});

test("usage() consulta GET /usage y devuelve camelCase", async () => {
  let seen;
  const fs = new FileService({
    apiKey: "k", baseUrl: "http://fs.test",
    fetch: async (url, init) => ((seen = { url, init }), new Response(
      JSON.stringify({ used_bytes: 400, quota_bytes: 1000, file_count: 3, max_file_size: 2048, allowed_mime_types: ["image/*"] }), { status: 200 })),
  });
  assert.deepEqual(await fs.usage(), { usedBytes: 400, quotaBytes: 1000, fileCount: 3, maxFileSize: 2048, allowedMimeTypes: ["image/*"] });
  assert.equal(seen.url, "http://fs.test/usage");
  assert.equal(seen.init.method, "GET");
});

test("uploadFile: firma las partes por lotes con look-ahead, no una por request", async () => {
  const { uploadFile } = await import("../dist/browser.js");
  installFakeXhr([]);
  const batches = [];
  const { parts } = await uploadFile(new Blob(["abcdefghij"]), { mode: "multipart", partSize: 1, partCount: 10 }, {
    concurrency: 2,
    signBatchSize: 4,
    signParts: async (ns) => (batches.push(ns), ns.map((n) => ({ partNumber: n, url: `http://s/${n}` }))),
  });
  assert.equal(parts.length, 10);
  assert.ok(batches.length <= 4, `pedidos: ${batches.length}`);
  assert.ok(batches.every((b) => b.length <= 4));
  assert.equal(new Set(batches.flat()).size, 10, "ninguna parte se firma dos veces");
});

test("uploadFile: una URL vencida (403) se vuelve a pedir sin abortar la subida", async () => {
  const { uploadFile, UploadError } = await import("../dist/browser.js");
  const calls = installFakeXhr([403, 200]);
  const signed = [];
  const { parts } = await uploadFile(new Blob(["ab"]), { mode: "multipart", partSize: 2, partCount: 1 }, {
    signParts: async (ns) => (signed.push(ns), ns.map((n) => ({ partNumber: n, url: `http://s/${n}?v=${signed.length}` }))),
  });
  assert.equal(parts.length, 1);
  assert.deepEqual(signed, [[1], [1]]);
  assert.deepEqual(calls.map((c) => c.url), ["http://s/1?v=1", "http://s/1?v=2"]);

  installFakeXhr([403, 403]);
  await assert.rejects(
    uploadFile(new Blob(["ab"]), { mode: "multipart", partSize: 2, partCount: 1 }, {
      signParts: async (ns) => ns.map((n) => ({ partNumber: n, url: "http://s/x" })),
    }),
    (e) => e instanceof UploadError && e.status === 403,
  );
});

test("uploadFile: un 5xx reintenta con la misma URL, sin volver a firmar", async () => {
  const { uploadFile } = await import("../dist/browser.js");
  installFakeXhr([500, 200]);
  let signs = 0;
  await uploadFile(new Blob(["ab"]), { mode: "multipart", partSize: 2, partCount: 1 }, {
    retries: 1,
    signParts: async (ns) => (signs++, ns.map((n) => ({ partNumber: n, url: "http://s/1" }))),
  });
  assert.equal(signs, 1);
});

// ─── Checksum declarado ──────────────────────────────────────────────────────

test("handleUpload: create pasa el sha256 válido a POST /files; sin sha256 no lo manda", async () => {
  const { sha256 } = vectors.declaredChecksum;
  const bodies = [];
  const fs = fakeApi((_url, init) => {
    bodies.push(JSON.parse(init.body));
    return json(201, { id: "f1", status: "PENDING", upload: { mode: "simple", url: "http://s/x", headers: {}, expires_at: "t" } });
  });
  const base = { action: "create", name: "a.txt", mimeType: "text/plain", size: 18 };
  assert.equal((await fs.handleUpload({ ...base, sha256 }, { ownerRef: "u" })).status, 200);
  assert.equal((await fs.handleUpload(base, { ownerRef: "u" })).status, 200);
  assert.equal((await fs.handleUpload({ ...base, sha256: null }, { ownerRef: "u" })).status, 200);
  assert.equal(bodies[0].sha256, sha256);
  assert.ok(!("sha256" in bodies[1]) && !("sha256" in bodies[2]), JSON.stringify(bodies));
});

test("handleUpload: create rechaza un sha256 inválido con 400 validation sin llamar a la API", async () => {
  let calls = 0;
  const fs = fakeApi(() => (calls++, json(500, {})));
  for (const { name, value } of vectors.declaredChecksum.invalid) {
    const r = await fs.handleUpload({ action: "create", name: "a", mimeType: "x/y", size: 1, sha256: value }, { ownerRef: "u" });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error.code, "validation", name);
  }
  assert.equal(calls, 0);
});

test("upload: en subida simple calcula el sha256 con WebCrypto y lo manda en create", async () => {
  const { upload } = await import("../dist/browser.js");
  const { content, sha256 } = vectors.declaredChecksum;
  const creates = [];
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.action === "create") creates.push(b);
    return { ok: true, json: async () => ({ id: "f", token: "t", upload: { mode: "simple", url: "http://s/x" }, status: "AVAILABLE" }) };
  };
  installFakeXhr([]);
  await upload(new Blob([content]), { endpoint: "http://e/files" });
  assert.equal(creates[0].sha256, sha256);
});

test("upload: un archivo que irá en multipart (≥ 32 MB) no se hashea", async () => {
  const { upload } = await import("../dist/browser.js");
  const creates = [];
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.action === "create") creates.push(b);
    return { ok: true, json: async () => ({ id: "f", token: "t", upload: { mode: "simple", url: "http://s/x" }, status: "AVAILABLE" }) };
  };
  installFakeXhr([]);
  const digest = crypto.subtle.digest;
  crypto.subtle.digest = () => assert.fail("no debe hashear un archivo multipart");
  try {
    await upload(new Blob([new Uint8Array(32 * 1024 * 1024)]), { endpoint: "http://e/files" });
  } finally {
    crypto.subtle.digest = digest;
  }
  assert.ok(!("sha256" in creates[0]));
});

test("uploadFile: el 400 del storage con checksum firmado → UploadError checksum_mismatch", async () => {
  const { uploadFile, UploadError } = await import("../dist/browser.js");
  const conChecksum = { mode: "simple", url: "http://s/x", headers: { "x-amz-checksum-sha256": "YEif…" } };
  installFakeXhr([400]);
  await assert.rejects(uploadFile(new Blob(["abc"]), conChecksum), (e) =>
    e instanceof UploadError && e.status === 400 && e.code === "checksum_mismatch");

  installFakeXhr([400]);
  await assert.rejects(uploadFile(new Blob(["abc"]), { mode: "simple", url: "http://s/x" }), (e) =>
    e instanceof UploadError && e.status === 400 && e.code === undefined);
});

test("upload (servidor): calcula el sha256 de bytes, ArrayBuffer y Blob y lo declara", async () => {
  const { content, sha256 } = vectors.declaredChecksum;
  const bytes = new TextEncoder().encode(content);
  for (const data of [bytes, bytes.buffer.slice(0), new Blob([content])]) {
    let created, put;
    const fs = new FileService({
      apiKey: "k", baseUrl: "http://fs.test",
      fetch: async (url, init) => {
        if (init.method === "PUT") return (put = Buffer.from(await init.body.arrayBuffer()).toString()), new Response("", { status: 200 });
        if (url.endsWith("/files")) return (created = JSON.parse(init.body)), new Response(JSON.stringify(simpleUpload), { status: 201 });
        return new Response(JSON.stringify(fileJson("READY")), { status: 200 });
      },
    });
    await fs.upload({ name: "a", mimeType: "text/plain", size: 0, data }, { wait: false });
    assert.equal(created.sha256, sha256, data.constructor.name);
    assert.equal(put, content);
  }
});

test("upload/createUpload: sha256 explícito se usa tal cual; inválido → validation sin llamar a la API", async () => {
  let created;
  const fs = new FileService({
    apiKey: "k", baseUrl: "http://fs.test",
    fetch: async (url, init) => {
      if (init.method === "PUT") return new Response("", { status: 200 });
      if (url.endsWith("/files")) return (created = JSON.parse(init.body)), new Response(JSON.stringify(simpleUpload), { status: 201 });
      return new Response(JSON.stringify(fileJson("READY")), { status: 200 });
    },
  });
  const otro = "0".repeat(64);
  await fs.upload({ name: "a", mimeType: "text/plain", size: 1, data: new Uint8Array([1]), sha256: otro }, { wait: false });
  assert.equal(created.sha256, otro);

  let calls = 0;
  const nunca = new FileService({ apiKey: "k", baseUrl: "http://fs.test", fetch: async () => (calls++, new Response("", { status: 500 })) });
  for (const { name, value } of vectors.declaredChecksum.invalid) {
    for (const call of [
      () => nunca.createUpload({ name: "a", mimeType: "x/y", size: 1, sha256: value }),
      () => nunca.upload({ name: "a", mimeType: "x/y", size: 1, data: new Uint8Array([1]), sha256: value }),
    ]) {
      await assert.rejects(call(), (e) => e instanceof FileServiceError && e.code === "validation", name);
    }
  }
  assert.equal(calls, 0);
});

test("upload (servidor): el 400 del storage con checksum firmado → checksum_mismatch", async () => {
  const withChecksum = { ...simpleUpload, upload: { ...simpleUpload.upload, headers: { "x-amz-checksum-sha256": "x" } } };
  for (const [created, code] of [[withChecksum, "checksum_mismatch"], [simpleUpload, "storage_rejected"]]) {
    const fs = new FileService({
      apiKey: "k", baseUrl: "http://fs.test",
      fetch: async (_url, init) => (init.method === "PUT" ? new Response("", { status: 400 }) : new Response(JSON.stringify(created), { status: 201 })),
    });
    await assert.rejects(fs.upload({ name: "a", mimeType: "text/plain", size: 1, data: new Uint8Array([1]) }), (e) => e.status === 400 && e.code === code);
  }
});

test("purge(): POST /files/{id}/purge con el Actor; 409 → invalid_state", async () => {
  const seen = [];
  const fs = fakeApi((url, init) => {
    seen.push({ method: init.method, path: url.pathname, actor: init.headers["FS-Actor"] });
    return url.pathname === "/files/en-curso/purge"
      ? json(409, { error: { code: "invalid_state", message: "subida en curso" } })
      : new Response(null, { status: 204 });
  });
  assert.equal(await fs.purge("f1", { actor: "user_1" }), undefined);
  assert.deepEqual(seen[0], { method: "POST", path: "/files/f1/purge", actor: "user_1" });
  await assert.rejects(fs.purge("en-curso"), (e) => e instanceof FileServiceError && e.status === 409 && e.code === "invalid_state");
});
