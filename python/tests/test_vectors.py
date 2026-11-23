"""Vectores compartidos por todos los SDKs (sdk/testdata/vectors.json)."""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ntropix_file_service import FileService, WebhookSignatureError  # noqa: E402
from ntropix_file_service._token import create_upload_token, verify_upload_token  # noqa: E402

VECTORS = json.loads((ROOT / ".." / "testdata" / "vectors.json").read_text("utf-8"))


class WebhookVectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.v = VECTORS["webhook"]

    def test_ok(self) -> None:
        with mock.patch("time.time", return_value=self.v["timestamp"] + 10):
            event = FileService.verify_webhook(self.v["payload"], self.v["signature"], self.v["secret"])
        exp = self.v["expected"]
        self.assertEqual(event.id, exp["id"])
        self.assertEqual(event.type, exp["type"])
        self.assertEqual(event.file.id, exp["fileId"])
        self.assertEqual(event.file.name, exp["fileName"])
        self.assertEqual(event.file.mime_type, exp["mimeType"])
        self.assertEqual(event.file.size, exp["size"])

    def test_ok_bytes_payload(self) -> None:
        with mock.patch("time.time", return_value=self.v["timestamp"]):
            event = FileService.verify_webhook(self.v["payload"].encode(), self.v["signature"], self.v["secret"])
        self.assertEqual(event.file.id, self.v["expected"]["fileId"])

    def test_tampered_signature(self) -> None:
        sig = self.v["signature"]
        tampered = sig[:-1] + ("0" if sig[-1] != "0" else "1")
        with mock.patch("time.time", return_value=self.v["timestamp"]):
            with self.assertRaisesRegex(WebhookSignatureError, "no coincide"):
                FileService.verify_webhook(self.v["payload"], tampered, self.v["secret"])

    def test_tampered_payload(self) -> None:
        with mock.patch("time.time", return_value=self.v["timestamp"]):
            with self.assertRaises(WebhookSignatureError):
                FileService.verify_webhook(self.v["payload"].replace("1234", "1235"), self.v["signature"], self.v["secret"])

    def test_too_old(self) -> None:
        # Sin reloj fijo el vector (2024) ya es viejo; además se prueba el borde exacto.
        with self.assertRaisesRegex(WebhookSignatureError, "viejo"):
            FileService.verify_webhook(self.v["payload"], self.v["signature"], self.v["secret"])
        with mock.patch("time.time", return_value=self.v["timestamp"] + 301):
            with self.assertRaisesRegex(WebhookSignatureError, "viejo"):
                FileService.verify_webhook(self.v["payload"], self.v["signature"], self.v["secret"])
        with mock.patch("time.time", return_value=self.v["timestamp"] + 300):
            FileService.verify_webhook(self.v["payload"], self.v["signature"], self.v["secret"])

    def test_missing_or_malformed_header(self) -> None:
        for sig in (None, "", "v1=abc", "t=abc,v1=00", "t=1731250000"):
            with self.subTest(sig=sig), self.assertRaises(WebhookSignatureError):
                FileService.verify_webhook(self.v["payload"], sig, self.v["secret"])


class UploadTokenVectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.key = VECTORS["uploadToken"]["apiKey"]
        self.cases = VECTORS["uploadToken"]["cases"]

    def test_generate_with_fixed_clock(self) -> None:
        for c in self.cases:
            with self.subTest(owner=c["ownerRef"]):
                now = c["exp"] - 86400
                self.assertEqual(create_upload_token(self.key, c["id"], c["ownerRef"], now=now), c["token"])

    def test_validate(self) -> None:
        for c in self.cases:
            with self.subTest(owner=c["ownerRef"]):
                self.assertTrue(verify_upload_token(self.key, c["token"], c["id"], c["ownerRef"], now=c["exp"] - 1))

    def test_other_owner_rejected(self) -> None:
        a, b = self.cases
        self.assertFalse(verify_upload_token(self.key, a["token"], a["id"], b["ownerRef"], now=a["exp"] - 1))
        self.assertFalse(verify_upload_token(self.key, a["token"], b["id"], a["ownerRef"], now=a["exp"] - 1))

    def test_expired_rejected(self) -> None:
        c = self.cases[0]
        self.assertFalse(verify_upload_token(self.key, c["token"], c["id"], c["ownerRef"], now=c["exp"]))
        self.assertFalse(verify_upload_token(self.key, c["token"], c["id"], c["ownerRef"], now=c["exp"] + 1))

    def test_other_key_or_garbage_rejected(self) -> None:
        c = self.cases[1]
        self.assertFalse(verify_upload_token("fsk_test_otra", c["token"], c["id"], c["ownerRef"], now=0))
        for bad in ("", "abc", "1999999999", "1999999999.", "x.y", "-1.00", "1999999999.ZZ"):
            with self.subTest(bad=bad):
                self.assertFalse(verify_upload_token(self.key, bad, c["id"], c["ownerRef"], now=0))


if __name__ == "__main__":
    unittest.main()
