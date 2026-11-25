"""`handle_upload` y el cliente HTTP contra un File Service falso local (sin red real)."""

import io
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ntropix_file_service import FileService, FileServiceError  # noqa: E402
from ntropix_file_service._token import create_upload_token  # noqa: E402

API_KEY = "fsk_test_unit"
VECTORS = json.loads((ROOT.parent / "testdata" / "vectors.json").read_text("utf-8"))
FILE_ID = "0193a1c7-2f00-7000-8000-0000000000aa"


def api_file(status: str = "READY", **extra: Any) -> Dict[str, Any]:
    f = {
        "id": FILE_ID,
        "project": "demo",
        "status": status,
        "original_name": "foto.jpg",
        "mime_type": "image/jpeg",
        "size_bytes": 10,
        "owner_ref": "user_1",
        "visibility": "private",
        "metadata": {},
        "created_at": "2026-11-10T12:00:00Z",
    }
    f.update(extra)
    return f


Response = Tuple[int, Any, Dict[str, str]]


def _json_or_raw(raw: bytes) -> Any:
    """Body JSON de la API, o los bytes crudos de un PUT al storage."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


class FakeAPI:
    """Servidor HTTP en un thread: responde con una cola de respuestas y guarda los requests."""

    def __init__(self) -> None:
        self.queue: List[Response] = []
        self.requests: List[Dict[str, Any]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": _json_or_raw(raw),
                    }
                )
                status, body, headers = fake.queue.pop(0) if fake.queue else (500, {"error": {"code": "internal", "message": "cola vacía"}}, {})
                data = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def reply(self, status: int, body: Any = None, headers: Optional[Dict[str, str]] = None) -> None:
        self.queue.append((status, body, headers or {}))

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class HandleUploadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeAPI()
        self.fs = FileService(api_key=API_KEY, base_url=self.api.url, timeout=5, retries=2)
        self.sleeps: List[float] = []
        self.fs._sleep = self.sleeps.append  # sin esperas reales

    def tearDown(self) -> None:
        self.api.close()

    def token(self, owner: str = "user_1", now: Optional[float] = None) -> str:
        return create_upload_token(API_KEY, FILE_ID, owner, now=now)

    # ─── Validación del body ─────────────────────────────────────────────

    def test_unknown_action_400(self) -> None:
        r = self.fs.handle_upload({"action": "borrar"}, owner_ref="user_1")
        self.assertEqual(r.status, 400)
        self.assertEqual(r.body["error"]["code"], "validation")
        self.assertEqual(self.api.requests, [])

    def test_invalid_bodies_400(self) -> None:
        for body in ("no es json", b"[1,2]", {"action": "create", "name": "a"}, {"action": "create", "name": "a", "mimeType": "x/y", "size": "10"}):
            with self.subTest(body=body):
                r = self.fs.handle_upload(body, owner_ref="user_1")
                self.assertEqual(r.status, 400)
                self.assertEqual(set(r.body["error"]), {"code", "message"})

    def test_missing_owner_401(self) -> None:
        r = self.fs.handle_upload({"action": "create"}, owner_ref="")
        self.assertEqual((r.status, r.body["error"]["code"]), (401, "unauthorized"))

    # ─── create ──────────────────────────────────────────────────────────

    def test_create_ok_returns_token(self) -> None:
        self.api.reply(
            201,
            {
                "id": FILE_ID,
                "status": "PENDING",
                "upload": {"mode": "simple", "url": "http://s3/x", "headers": {"Content-Type": "image/jpeg"}, "expires_at": "2026-11-10T13:00:00Z"},
            },
        )
        body = json.dumps({"action": "create", "name": "foto.jpg", "mimeType": "image/jpeg", "size": 10, "metadata": {"album": "x", "k": "cliente"}})
        with mock.patch("time.time", return_value=1_731_250_000):
            r = self.fs.handle_upload(body.encode(), owner_ref="user_1", visibility="public", metadata={"k": "backend"})
        self.assertEqual(r.status, 200, r.body)
        self.assertEqual(r.body["id"], FILE_ID)
        self.assertEqual(r.body["token"], self.token(now=1_731_250_000))
        self.assertEqual(
            r.body["upload"],
            {"mode": "simple", "url": "http://s3/x", "headers": {"Content-Type": "image/jpeg"}, "expiresAt": "2026-11-10T13:00:00Z"},
        )
        req = self.api.requests[0]
        self.assertEqual((req["method"], req["path"]), ("POST", "/files"))
        self.assertEqual(req["headers"]["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(req["headers"]["fs-actor"], "user_1")
        self.assertEqual(
            req["body"],
            {
                "original_name": "foto.jpg",
                "mime_type": "image/jpeg",
                "size_bytes": 10,
                "owner_ref": "user_1",
                "visibility": "public",
                "metadata": {"album": "x", "k": "backend"},
            },
        )

    def test_create_pasa_el_sha256_declarado(self) -> None:
        sha = VECTORS["declaredChecksum"]["sha256"]
        for extra in ({"sha256": sha}, {}, {"sha256": None}):
            with self.subTest(extra=extra):
                self.api.requests.clear()
                self.api.reply(201, {"id": FILE_ID, "status": "PENDING", "upload": {"mode": "simple", "url": "u", "headers": {}, "expires_at": "e"}})
                r = self.fs.handle_upload({"action": "create", "name": "a.txt", "mimeType": "text/plain", "size": 18, **extra}, owner_ref="u")
                self.assertEqual(r.status, 200, r.body)
                body = self.api.requests[0]["body"]
                if extra.get("sha256"):
                    self.assertEqual(body["sha256"], sha)
                else:
                    self.assertNotIn("sha256", body)

    def test_create_sha256_invalido_400_sin_llamar_a_la_api(self) -> None:
        for case in VECTORS["declaredChecksum"]["invalid"]:
            with self.subTest(name=case["name"]):
                r = self.fs.handle_upload({"action": "create", "name": "a", "mimeType": "x/y", "size": 1, "sha256": case["value"]}, owner_ref="u")
                self.assertEqual((r.status, r.body["error"]["code"]), (400, "validation"))
        self.assertEqual(self.api.requests, [])

    def test_create_multipart_instructions_camel_case(self) -> None:
        self.api.reply(201, {"id": FILE_ID, "status": "PENDING", "upload": {"mode": "multipart", "part_size": 8388608, "part_count": 5, "expires_at": "e"}})
        r = self.fs.handle_upload({"action": "create", "name": "a.bin", "mimeType": "application/octet-stream", "size": 40 << 20}, owner_ref="u")
        self.assertEqual(r.body["upload"], {"mode": "multipart", "partSize": 8388608, "partCount": 5, "expiresAt": "e"})

    def test_api_error_propagates(self) -> None:
        self.api.reply(413, {"error": {"code": "too_large", "message": "supera el máximo"}})
        r = self.fs.handle_upload({"action": "create", "name": "a.bin", "mimeType": "x/y", "size": 10**12}, owner_ref="u")
        self.assertEqual(r.status, 413)
        self.assertEqual(r.body, {"error": {"code": "too_large", "message": "supera el máximo"}})
        self.assertEqual(len(self.api.requests), 1)

    def test_backend_key_rejected_is_502_not_401_403(self) -> None:
        # La key del backend rechazada por la API no debe confundirse con "usuario sin sesión".
        cases = [
            (401, "unauthorized", {"action": "create", "name": "a", "mimeType": "x/y", "size": 1}),
            (403, "forbidden", {"action": "create", "name": "a", "mimeType": "x/y", "size": 1}),
            (403, "project_disabled", {"action": "complete", "id": FILE_ID, "token": create_upload_token(API_KEY, FILE_ID, "u")}),
        ]
        for status, code, body in cases:
            with self.subTest(code=code):
                self.api.reply(status, {"error": {"code": code, "message": "key rechazada"}})
                r = self.fs.handle_upload(body, owner_ref="u")
                self.assertEqual(r.status, 502)
                self.assertEqual(r.body, {"error": {"code": code, "message": "key rechazada"}})

    def test_create_is_not_retried(self) -> None:
        self.api.reply(503, {"error": {"code": "internal", "message": "caído"}})
        r = self.fs.handle_upload({"action": "create", "name": "a", "mimeType": "x/y", "size": 1}, owner_ref="u")
        self.assertEqual(r.status, 503)
        self.assertEqual(len(self.api.requests), 1)

    def test_network_error_502(self) -> None:
        self.api.close()
        r = self.fs.handle_upload({"action": "create", "name": "a", "mimeType": "x/y", "size": 1}, owner_ref="u")
        self.api = FakeAPI()  # para tearDown
        self.assertEqual((r.status, r.body["error"]["code"]), (502, "network"))

    # ─── token ───────────────────────────────────────────────────────────

    def test_token_other_owner_403(self) -> None:
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token("user_1")}, owner_ref="user_2")
        self.assertEqual((r.status, r.body["error"]["code"]), (403, "forbidden"))
        self.assertEqual(self.api.requests, [])

    def test_token_expired_403(self) -> None:
        tok = self.token(now=1_000_000)
        with mock.patch("time.time", return_value=1_000_000 + 86_400):
            r = self.fs.handle_upload({"action": "parts", "id": FILE_ID, "token": tok, "partNumbers": [1]}, owner_ref="user_1")
        self.assertEqual(r.status, 403)
        with mock.patch("time.time", return_value=1_000_000 + 86_399):
            self.api.reply(200, {"urls": [{"part_number": 1, "url": "http://s3/p1"}], "expires_at": "e"})
            r = self.fs.handle_upload({"action": "parts", "id": FILE_ID, "token": tok, "partNumbers": [1]}, owner_ref="user_1")
        self.assertEqual(r.status, 200)

    def test_token_for_other_file_403(self) -> None:
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID.replace("aa", "bb"), "token": self.token()}, owner_ref="user_1")
        self.assertEqual(r.status, 403)

    # ─── parts / complete ────────────────────────────────────────────────

    def test_parts_ok(self) -> None:
        self.api.reply(200, {"urls": [{"part_number": 1, "url": "u1"}, {"part_number": 2, "url": "u2"}], "expires_at": "e"})
        r = self.fs.handle_upload({"action": "parts", "id": FILE_ID, "token": self.token(), "partNumbers": [1, 2]}, owner_ref="user_1")
        self.assertEqual(r.body, {"urls": [{"partNumber": 1, "url": "u1"}, {"partNumber": 2, "url": "u2"}]})
        self.assertEqual(self.api.requests[0]["body"], {"part_numbers": [1, 2]})

    def test_parts_more_than_100_400(self) -> None:
        r = self.fs.handle_upload({"action": "parts", "id": FILE_ID, "token": self.token(), "partNumbers": list(range(1, 102))}, owner_ref="user_1")
        self.assertEqual(r.status, 400)

    def test_complete_waits_until_available(self) -> None:
        self.api.reply(200, api_file("READY"))
        self.api.reply(200, api_file("READY"))
        self.api.reply(200, api_file("AVAILABLE", content_hash="abc", download={"url": "http://s3/dl", "expires_at": "e"}))
        parts = [{"partNumber": 1, "etag": '"e1"'}, {"partNumber": 2, "etag": "e2"}]
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token(), "parts": parts}, owner_ref="user_1")
        self.assertEqual(r.status, 200, r.body)
        self.assertEqual(r.body["status"], "AVAILABLE")
        self.assertEqual(r.body["mimeType"], "image/jpeg")
        self.assertEqual(r.body["contentHash"], "abc")
        self.assertEqual(r.body["download"], {"url": "http://s3/dl", "expiresAt": "e"})
        self.assertEqual(r.file.status, "AVAILABLE")
        self.assertEqual(self.api.requests[0]["body"], {"parts": [{"part_number": 1, "etag": "e1"}, {"part_number": 2, "etag": "e2"}]})
        self.assertEqual(self.sleeps, [0.5, 0.75])

    def test_complete_wait_timeout_returns_ready(self) -> None:
        for _ in range(10):
            self.api.reply(200, api_file("READY"))
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token()}, owner_ref="user_1", wait_timeout=1)
        self.assertEqual((r.status, r.body["status"]), (200, "READY"))
        self.assertIsNone(self.api.requests[0]["body"])  # simple: sin body

    def test_complete_quarantined_422(self) -> None:
        self.api.reply(200, api_file("READY"))
        self.api.reply(200, api_file("QUARANTINED", mime_type="application/x-msdownload"))
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token()}, owner_ref="user_1")
        self.assertEqual((r.status, r.body["error"]["code"]), (422, "quarantined"))
        self.assertEqual(r.file.status, "QUARANTINED")

    def test_complete_retries_on_503(self) -> None:
        self.api.reply(503, {"error": {"code": "internal", "message": "caído"}})
        self.api.reply(429, {"error": {"code": "rate_limited", "message": "despacio"}}, {"Retry-After": "2"})
        self.api.reply(200, api_file("AVAILABLE"))
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token()}, owner_ref="user_1")
        self.assertEqual((r.status, r.body["status"]), (200, "AVAILABLE"))
        self.assertEqual(len(self.api.requests), 3)
        self.assertEqual(self.sleeps, [0.25, 2.0])

    def test_retries_exhausted_propagates_last_error(self) -> None:
        for _ in range(3):
            self.api.reply(503, {"error": {"code": "storage_unavailable", "message": "caído"}})
        r = self.fs.handle_upload({"action": "complete", "id": FILE_ID, "token": self.token()}, owner_ref="user_1")
        self.assertEqual((r.status, r.body["error"]["code"]), (503, "storage_unavailable"))
        self.assertEqual(len(self.api.requests), 3)


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeAPI()
        self.fs = FileService(api_key=API_KEY, base_url=self.api.url + "/", timeout=5)
        self.fs._sleep = lambda s: None

    def tearDown(self) -> None:
        self.api.close()

    def test_errors_and_actor(self) -> None:
        self.api.reply(404, {"error": {"code": "not_found", "message": "no existe"}})
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.get("x/y", actor="user_9")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "not_found"))
        req = self.api.requests[0]
        self.assertEqual(req["path"], "/files/x%2Fy")
        self.assertEqual(req["headers"]["fs-actor"], "user_9")

    def test_api_error_exposes_request_id_network_error_does_not(self) -> None:
        self.api.reply(404, {"error": {"code": "not_found", "message": "no existe"}}, {"X-Request-ID": "req-123"})
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.get("f1")
        self.assertEqual(ctx.exception.request_id, "req-123")

        offline = FileService(api_key=API_KEY, base_url="http://127.0.0.1:9", timeout=2, retries=0)
        with self.assertRaises(FileServiceError) as ctx:
            offline.get("f1")
        self.assertEqual((ctx.exception.code, ctx.exception.request_id), ("network", None))

    def test_list_iter_all_update_delete(self) -> None:
        self.api.reply(200, {"files": [api_file()], "next_cursor": "c1"})
        self.api.reply(200, {"files": [api_file()], "next_cursor": ""})
        files = list(self.fs.iter_all(owner_ref="user_1", trashed=True, limit=1))
        self.assertEqual(len(files), 2)
        self.assertEqual(self.api.requests[0]["path"], "/files?owner_ref=user_1&trashed=true&limit=1")
        self.assertEqual(self.api.requests[1]["path"], "/files?owner_ref=user_1&trashed=true&cursor=c1&limit=1")

        self.api.reply(200, api_file(visibility="public", public_url="http://fs/p/x/foto.jpg"))
        f = self.fs.update(FILE_ID, visibility="public")
        self.assertEqual(f.public_url, "http://fs/p/x/foto.jpg")
        self.assertEqual(self.api.requests[2]["body"], {"visibility": "public"})

        self.api.reply(204)
        self.assertIsNone(self.fs.delete(FILE_ID))
        self.assertEqual(self.api.requests[3]["method"], "DELETE")

    def test_purge(self) -> None:
        self.api.reply(204)
        self.assertIsNone(self.fs.purge(FILE_ID, actor="user_9"))
        req = self.api.requests[0]
        self.assertEqual((req["method"], req["path"], req["headers"]["fs-actor"]), ("POST", f"/files/{FILE_ID}/purge", "user_9"))
        self.api.reply(409, {"error": {"code": "invalid_state", "message": "subida en curso"}})
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.purge(FILE_ID)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "invalid_state"))

    def test_put_412_on_retry_is_success(self) -> None:
        # Escritura única (If-None-Match: *): el 1.er PUT escribió pero su respuesta se perdió (503 acá);
        # el reintento recibe 412 y eso cuenta como subido.
        fs = FileService(api_key=API_KEY, base_url=self.api.url, timeout=5, retries=2)
        fs._sleep = lambda s: None
        self.api.reply(503)
        self.api.reply(412)
        body = b'"x"'
        self.assertEqual(fs._put(self.api.url + "/storage/0", lambda: io.BytesIO(body), len(body), {"If-None-Match": "*"}), "")
        self.assertEqual(len(self.api.requests), 2)

    def test_put_412_on_first_attempt_is_error(self) -> None:
        self.api.reply(412)
        body = b'"x"'
        with self.assertRaises(FileServiceError) as ctx:
            self.fs._put(self.api.url + "/storage/0", lambda: io.BytesIO(body), len(body), {"If-None-Match": "*"})
        self.assertEqual(ctx.exception.status, 412)

    def test_get_download_url_not_available(self) -> None:
        self.api.reply(200, api_file("READY"))
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.get_download_url(FILE_ID)
        self.assertEqual(ctx.exception.code, "invalid_state")


class DeclaredChecksumUploadTest(unittest.TestCase):
    """Checksum declarado en upload() / create_upload() (sdk/PROTOCOL.md)."""

    CONTENT = VECTORS["declaredChecksum"]["content"].encode()
    SHA = VECTORS["declaredChecksum"]["sha256"]

    def setUp(self) -> None:
        self.api = FakeAPI()
        self.fs = FileService(api_key=API_KEY, base_url=self.api.url, timeout=5, retries=0)
        self.fs._sleep = lambda s: None

    def tearDown(self) -> None:
        self.api.close()

    def simple_flow(self, put_status: int = 200, checksum: bool = True) -> None:
        headers = {"x-amz-checksum-sha256": "x"} if checksum else {}
        self.api.reply(201, {"id": FILE_ID, "status": "PENDING", "upload": {"mode": "simple", "url": self.api.url + "/storage/0", "headers": headers, "expires_at": "e"}})
        self.api.reply(put_status, None, {"ETag": '"e"'})
        self.api.reply(200, api_file("READY"))

    def create_body(self) -> Dict[str, Any]:
        return self.api.requests[0]["body"]

    def test_bytes_ruta_y_archivo_con_seek_calculan_el_sha256(self) -> None:
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(b"prefijo" + self.CONTENT)
        self.addCleanup(lambda: Path(tmp.name).unlink())
        con_offset = open(tmp.name, "rb")
        self.addCleanup(con_offset.close)
        con_offset.seek(len(b"prefijo"))
        cases = [("bytes", self.CONTENT), ("archivo con seek (desde su posición)", con_offset)]
        for name, data in cases:
            with self.subTest(name):
                self.api.requests.clear()
                self.simple_flow()
                self.fs.upload("a.txt", "text/plain", data, wait=False)
                self.assertEqual(self.create_body()["sha256"], self.SHA)
                self.assertEqual((self.api.requests[1]["method"], self.api.requests[1]["body"]), ("PUT", self.CONTENT))
        with tempfile.NamedTemporaryFile(delete=False) as only:
            only.write(self.CONTENT)
        self.addCleanup(lambda: Path(only.name).unlink())
        self.api.requests.clear()
        self.simple_flow()
        self.fs.upload("a.txt", "text/plain", only.name, wait=False)
        self.assertEqual(self.create_body()["sha256"], self.SHA)

    def test_stream_sin_seek_no_calcula_nada_salvo_sha256_explicito(self) -> None:
        class OneShot(io.RawIOBase):
            def __init__(self, data: bytes) -> None:
                self.inner = io.BytesIO(data)

            def readable(self) -> bool:
                return True

            def seekable(self) -> bool:
                return False

            def readinto(self, b: Any) -> int:
                return self.inner.readinto(b)

        self.simple_flow(checksum=False)
        self.fs.upload("a.txt", "text/plain", OneShot(self.CONTENT), wait=False)
        self.assertNotIn("sha256", self.create_body())

        self.api.requests.clear()
        self.simple_flow()
        self.fs.upload("a.txt", "text/plain", OneShot(self.CONTENT), sha256=self.SHA, wait=False)
        self.assertEqual(self.create_body()["sha256"], self.SHA)

    def test_sha256_explicito_no_se_recalcula(self) -> None:
        otro = "0" * 64
        self.simple_flow()
        self.fs.upload("a.txt", "text/plain", self.CONTENT, sha256=otro, wait=False)
        self.assertEqual(self.create_body()["sha256"], otro)

    def test_sha256_invalido_validation_sin_llamar_a_la_api(self) -> None:
        for case in VECTORS["declaredChecksum"]["invalid"]:
            with self.subTest(case["name"]):
                for call in (
                    lambda v=case["value"]: self.fs.create_upload("a", "x/y", 1, sha256=v),
                    lambda v=case["value"]: self.fs.upload("a", "x/y", b"a", sha256=v),
                ):
                    with self.assertRaises(FileServiceError) as ctx:
                        call()
                    self.assertEqual(ctx.exception.code, "validation")
        self.assertEqual(self.api.requests, [])

    def test_rechazo_del_storage_por_checksum_es_checksum_mismatch(self) -> None:
        self.simple_flow(put_status=400)
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.upload("a.txt", "text/plain", self.CONTENT, wait=False)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (400, "checksum_mismatch"))

        self.api.queue.clear()
        self.simple_flow(put_status=400, checksum=False)
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.upload("a.txt", "text/plain", self.CONTENT, wait=False)
        self.assertEqual(ctx.exception.code, "storage_rejected", "sin checksum firmado, un 400 es otro rechazo")


if __name__ == "__main__":
    unittest.main()
