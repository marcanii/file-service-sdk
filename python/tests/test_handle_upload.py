"""`handle_upload` y el cliente HTTP contra un File Service falso local (sin red real)."""

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
                        "body": json.loads(raw) if raw else None,
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

    def test_get_download_url_not_available(self) -> None:
        self.api.reply(200, api_file("READY"))
        with self.assertRaises(FileServiceError) as ctx:
            self.fs.get_download_url(FILE_ID)
        self.assertEqual(ctx.exception.code, "invalid_state")


if __name__ == "__main__":
    unittest.main()
