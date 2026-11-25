"""Comportamiento HTTP uniforme entre SDKs (issue #69)."""

import email.utils
import sys
import time
import unittest
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from test_handle_upload import API_KEY, FILE_ID, FakeAPI  # noqa: E402

from ntropix_file_service import FileService, FileServiceError, __version__  # noqa: E402
from ntropix_file_service.client import _parse_retry_after  # noqa: E402

RAW_FILE = {
    "id": FILE_ID,
    "project": "p",
    "status": "READY",
    "original_name": "a.txt",
    "mime_type": "text/plain",
    "size_bytes": 1,
    "visibility": "private",
    "created_at": "2026-01-01T00:00:00Z",
}
CREATED = {"id": FILE_ID, "status": "PENDING", "upload": {"mode": "simple", "url": "http://x", "headers": {}}}
ERR = {"error": {"code": "rate_limited", "message": "x"}}


class HttpClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeAPI()
        self.fs = FileService(api_key=API_KEY, base_url=self.api.url, timeout=5, retries=2)
        self.sleeps: List[float] = []
        self.fs._sleep = self.sleeps.append

    def tearDown(self) -> None:
        self.api.close()

    def test_user_agent_en_la_api(self) -> None:
        self.api.reply(200, RAW_FILE)
        self.fs.get(FILE_ID)
        self.assertEqual(self.api.requests[0]["headers"]["user-agent"], f"ntropix-file-service-python/{__version__}")

    def test_usage(self) -> None:
        self.api.reply(200, {"used_bytes": 400, "quota_bytes": 1000, "file_count": 3,
                             "max_file_size": 2048, "allowed_mime_types": ["image/*"]})
        u = self.fs.usage()
        self.assertEqual((u.used_bytes, u.quota_bytes, u.file_count, u.max_file_size, u.allowed_mime_types),
                         (400, 1000, 3, 2048, ["image/*"]))
        self.assertEqual((self.api.requests[0]["method"], self.api.requests[0]["path"]), ("GET", "/usage"))

    def test_retry_after_tope_60s(self) -> None:
        self.api.reply(429, ERR, {"Retry-After": "3600"})
        self.api.reply(200, RAW_FILE)
        self.fs.get(FILE_ID)
        self.assertEqual(self.sleeps, [60.0])

    def test_retry_after_fecha_http(self) -> None:
        date = email.utils.formatdate(time.time() + 600, usegmt=True)
        self.assertEqual(_parse_retry_after(date), 60.0)
        near = _parse_retry_after(email.utils.formatdate(time.time() + 20, usegmt=True))
        assert near is not None
        self.assertTrue(15 <= near <= 20)
        self.assertIsNone(_parse_retry_after(email.utils.formatdate(time.time() - 20, usegmt=True)))

    def test_create_reintenta_429(self) -> None:
        self.api.reply(429, ERR, {"Retry-After": "2"})
        self.api.reply(201, CREATED)
        self.fs.create_upload("a.txt", "text/plain", 1)
        self.assertEqual(len(self.api.requests), 2)
        self.assertEqual(self.sleeps, [2.0])

    def test_create_no_reintenta_5xx(self) -> None:
        self.api.reply(503, {"error": {"code": "internal", "message": "x"}})
        with self.assertRaises(FileServiceError):
            self.fs.create_upload("a.txt", "text/plain", 1)
        self.assertEqual(len(self.api.requests), 1)

    def test_create_429_agotado(self) -> None:
        for _ in range(3):
            self.api.reply(429, ERR)
        with self.assertRaises(FileServiceError) as cm:
            self.fs.create_upload("a.txt", "text/plain", 1)
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(len(self.api.requests), 3)

    def test_complete_sin_espera(self) -> None:
        for w in (False, None, 0, 0.0, -1):
            with self.subTest(wait=w):
                self.api.requests.clear()
                self.api.reply(200, RAW_FILE)
                f = self.fs.complete(FILE_ID, wait=w)  # type: ignore[arg-type]
                self.assertEqual(f.status, "READY")
                self.assertEqual(len(self.api.requests), 1)

    def test_status_desconocido_no_lanza(self) -> None:
        self.api.reply(200, {**RAW_FILE, "status": "ARCHIVED", "visibility": "internal"})
        f = self.fs.get(FILE_ID)
        self.assertEqual((f.status, f.visibility), ("ARCHIVED", "internal"))


if __name__ == "__main__":
    unittest.main()
