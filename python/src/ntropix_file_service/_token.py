"""Token de subida: prueba sin estado de que el `id` lo creó este usuario (ver PROTOCOL.md).

    token = "<exp>.<hex(HMAC-SHA256(key=api_key, msg="fs-upload-token.v1:<id>:<owner_ref>:<exp>"))>"
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Optional

#: Formato canónico (sdk/PROTOCOL.md): exp = 1 a 12 dígitos ASCII sin ceros a la izquierda; MAC = 64 hex en minúscula.
CANONICAL_UNIX = re.compile(r"[1-9][0-9]{0,11}", re.ASCII)
LOWER_HEX_SHA256 = re.compile(r"[0-9a-f]{64}", re.ASCII)

#: Vida del token: 24 h, igual que `ABANDONED_UPLOAD_TIMEOUT`.
TOKEN_TTL_SECONDS = 86400


def _sign(api_key: str, file_id: str, owner_ref: str, exp: int) -> str:
    msg = f"fs-upload-token.v1:{file_id}:{owner_ref}:{exp}".encode("utf-8")
    return hmac.new(api_key.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def create_upload_token(api_key: str, file_id: str, owner_ref: str, now: Optional[float] = None) -> str:
    """Emite un token que vence en 24 h."""
    exp = int(time.time() if now is None else now) + TOKEN_TTL_SECONDS
    return f"{exp}.{_sign(api_key, file_id, owner_ref, exp)}"


def verify_upload_token(api_key: str, token: str, file_id: str, owner_ref: str, now: Optional[float] = None) -> bool:
    """`True` si el token es de este `file_id` + `owner_ref` y no venció. Tiempo constante."""
    if not isinstance(token, str):
        return False
    exp_str, sep, mac = token.partition(".")
    if not sep or not CANONICAL_UNIX.fullmatch(exp_str) or not LOWER_HEX_SHA256.fullmatch(mac):
        return False
    exp = int(exp_str)
    current = time.time() if now is None else now
    if exp <= current:
        return False
    expected = _sign(api_key, file_id, owner_ref, exp)
    return hmac.compare_digest(expected.encode("ascii"), mac.encode("ascii"))
