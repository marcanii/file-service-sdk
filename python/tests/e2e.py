"""Prueba del SDK contra un File Service real (stack local levantado).

    FS_KEY=fsk_test_... [FS_URL=http://localhost:8080] python3 tests/e2e.py
"""

import hashlib
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ntropix_file_service import FileService, FileServiceError  # noqa: E402

KEY = os.environ.get("FS_KEY")
if not KEY:
    sys.exit("falta la variable de entorno FS_KEY")
fs = FileService(api_key=KEY, base_url=os.environ.get("FS_URL", "http://localhost:8080"))


def step(name: str) -> None:
    print(f"  ✓ {name}", flush=True)


def put(url: str, data: bytes, headers: dict) -> int:
    req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.status


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as res:
        return res.read()


# (a) Flujo del navegador a través de handle_upload: create → PUT directo → complete.
text = (f"hola desde el sdk de python {os.urandom(8).hex()}\n" * 20).encode()
r = fs.handle_upload(
    {"action": "create", "name": "nota.txt", "mimeType": "text/plain", "size": len(text), "metadata": {"origen": "py"}},
    owner_ref="user_py",
    metadata={"backend": True},
)
assert r.status == 200, r.body
created = r.body
assert created["upload"]["mode"] == "simple" and created["token"].count(".") == 1
assert put(created["upload"]["url"], text, created["upload"].get("headers", {})) == 200
r = fs.handle_upload({"action": "complete", "id": created["id"], "token": created["token"]}, owner_ref="user_py")
assert r.status == 200, r.body
assert r.body["status"] == "AVAILABLE", r.body
assert r.body["contentHash"] == hashlib.sha256(text).hexdigest()
assert r.body["metadata"] == {"origen": "py", "backend": True}, r.body["metadata"]
assert r.file is not None and r.file.owner_ref == "user_py"
step("handle_upload create → PUT → complete: 200 y AVAILABLE")

# (a2) Lo mismo en multipart: create → parts (lotes) → PUT de cada parte → complete con ETags.
big_browser = os.urandom(33 << 20)
r = fs.handle_upload(
    {"action": "create", "name": "video.bin", "mimeType": "application/octet-stream", "size": len(big_browser)},
    owner_ref="user_py",
)
assert r.status == 200 and r.body["upload"]["mode"] == "multipart", r.body
mid, mtok, up = r.body["id"], r.body["token"], r.body["upload"]
r = fs.handle_upload({"action": "parts", "id": mid, "token": mtok, "partNumbers": list(range(1, up["partCount"] + 1))}, owner_ref="user_py")
assert r.status == 200 and len(r.body["urls"]) == up["partCount"], r.body
etags = []
for u in r.body["urls"]:
    n, size = u["partNumber"], up["partSize"]
    req = urllib.request.Request(u["url"], data=big_browser[(n - 1) * size : n * size], method="PUT")
    with urllib.request.urlopen(req, timeout=60) as res:
        etags.append({"partNumber": n, "etag": res.headers["ETag"]})
r = fs.handle_upload({"action": "complete", "id": mid, "token": mtok, "parts": etags}, owner_ref="user_py", wait_timeout=120)
assert r.status == 200 and r.body["status"] == "AVAILABLE", r.body
assert r.body["contentHash"] == hashlib.sha256(big_browser).hexdigest()
step(f"handle_upload multipart create → parts → {len(etags)} PUTs → complete: AVAILABLE")

# (b) Token de otro owner → 403 (y no se llama a la API).
r2 = fs.handle_upload({"action": "create", "name": "ajeno.txt", "mimeType": "text/plain", "size": 10}, owner_ref="user_a")
assert r2.status == 200, r2.body
r = fs.handle_upload({"action": "complete", "id": r2.body["id"], "token": r2.body["token"]}, owner_ref="user_b")
assert r.status == 403 and r.body["error"]["code"] == "forbidden", r.body
r = fs.handle_upload({"action": "nada"}, owner_ref="user_a")
assert r.status == 400 and r.body["error"]["code"] == "validation", r.body
step("complete con el token de otro owner → 403; action desconocida → 400")

# Errores de la API propagados por handle_upload.
r = fs.handle_upload({"action": "create", "name": "x.bin", "mimeType": "application/octet-stream", "size": 1 << 50}, owner_ref="user_a")
assert r.status == 413 and r.body["error"]["code"] == "too_large", r.body
step("handle_upload propaga los errores de la API (413 too_large)")

# (c) upload() server-side de ~40 MB desde una ruta: multipart, leído por partes.
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "grande.bin"
    h = hashlib.sha256()
    with open(path, "wb") as fh:
        for _ in range(40):
            chunk = os.urandom(1 << 20)
            h.update(chunk)
            fh.write(chunk)
    signed = []  # se espía sign_parts para confirmar que la subida fue multipart
    original_sign_parts = fs.sign_parts
    fs.sign_parts = lambda id, nums, **kw: signed.extend(nums) or original_sign_parts(id, nums, **kw)  # type: ignore
    big = fs.upload("grande.bin", "application/octet-stream", path, owner_ref="user_py", wait=120)
    del fs.sign_parts
assert big.status == "AVAILABLE", big
assert len(signed) >= 2, signed
assert big.size == 40 << 20 and big.content_hash == h.hexdigest()
step(f"upload() multipart de 40 MB ({len(signed)} partes) → AVAILABLE, hash correcto")

small = fs.upload("reporte.pdf", "application/pdf", b"%PDF-1.7\nreporte " + os.urandom(8).hex().encode() + b"\n", owner_ref="user_py")
assert small.status == "AVAILABLE" and small.mime_type == "application/pdf", small
step("upload() simple de bytes → AVAILABLE")

# (d) get / list / update public / delete / restore.
fid = created["id"]
f = fs.get(fid, actor="user_py")
assert f.download is not None and fetch(f.download.url) == text
assert fetch(fs.get_download_url(fid)) == text
step("get + get_download_url entregan los mismos bytes")

page = fs.list(owner_ref="user_py", limit=1)
assert len(page.files) == 1 and page.next_cursor
ids = [x.id for x in fs.iter_all(owner_ref="user_py", limit=2)]
assert fid in ids and mid in ids and big.id in ids and small.id in ids, ids
step(f"list(limit=1) pagina y iter_all recorre todo ({len(ids)} files de user_py)")

pub = fs.update(fid, visibility="public", name="nota-publica.txt")
assert pub.visibility == "public" and pub.public_url and pub.name == "nota-publica.txt", pub
assert fetch(pub.public_url) == text
priv = fs.update(fid, visibility="private")
assert priv.public_url is None
try:
    fetch(pub.public_url)
    raise AssertionError("la URL pública debería dejar de funcionar")
except urllib.error.HTTPError as exc:
    assert exc.code == 404, exc.code
step("update(visibility='public') prende la URL estable; 'private' la apaga")

fs.delete(fid)
assert fs.get(fid).deleted_at
assert any(x.id == fid for x in fs.iter_all(trashed=True, owner_ref="user_py"))
restored = fs.restore(fid)
assert restored.deleted_at is None
step("delete → papelera → restore")

try:
    fs.get("00000000-0000-7000-8000-000000000000")
    raise AssertionError("debería lanzar not_found")
except FileServiceError as exc:
    assert (exc.status, exc.code) == (404, "not_found"), exc
try:
    FileService(api_key="fsk_test_mala", base_url=os.environ.get("FS_URL", "http://localhost:8080")).list()
    raise AssertionError("debería lanzar unauthorized")
except FileServiceError as exc:
    assert exc.code == "unauthorized", exc
step("errores tipados (not_found, unauthorized)")

print("\nSDK Python e2e OK")
