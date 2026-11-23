"""Cliente de servidor del File Service de ntropix.

Se usa SOLO en el backend del Proyecto: la API key nunca debe llegar al navegador. El navegador
recibe únicamente instrucciones de subida (URLs firmadas) a través de `handle_upload()`.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import (
    Any,
    BinaryIO,
    Callable,
    Dict,
    Iterable,
    Iterator,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
)

from ._token import create_upload_token, verify_upload_token
from .errors import FileRejectedError, FileServiceError, WebhookSignatureError
from .models import (
    CompletedPart,
    CreatedUpload,
    FileInfo,
    FilePage,
    PartUrl,
    UploadInstructions,
    UploadResult,
    WebhookEvent,
)

__all__ = ["FileService"]

#: Contenido aceptado por `upload()`: bytes, una ruta o un archivo binario abierto.
UploadData = Union[bytes, bytearray, memoryview, str, "os.PathLike[str]", BinaryIO]

#: Partes completadas: `CompletedPart`, dicts (`part_number`/`partNumber` + `etag`) o tuplas.
PartsInput = Iterable[Union[CompletedPart, Mapping[str, Any], Tuple[int, str]]]

_MAX_PARTS_PER_REQUEST = 100
_USER_AGENT = "ntropix-file-service-python/1.0.0"


def _strip_quotes(etag: str) -> str:
    return etag[1:-1] if len(etag) >= 2 and etag[0] == '"' and etag[-1] == '"' else etag


def _error(status: int, code: str, message: str) -> Dict[str, Any]:
    return {"error": {"code": code, "message": message}}


class FileService:
    """Cliente del File Service.

    :param api_key: API key del Proyecto (`fsk_live_...` / `fsk_test_...`).
    :param base_url: URL de la API, ej. `https://files.ntropix.dev`.
    :param timeout: tiempo máximo por request, en segundos.
    :param retries: reintentos ante red, 429 y 5xx en operaciones seguras de repetir.
    """

    def __init__(self, api_key: str, base_url: str, timeout: float = 30, retries: int = 2) -> None:
        if not api_key:
            raise ValueError("FileService: falta api_key")
        if not base_url:
            raise ValueError("FileService: falta base_url")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._retries = max(0, int(retries))
        # Inyectable en tests.
        self._sleep: Callable[[float], None] = time.sleep

    def __repr__(self) -> str:  # nunca mostrar la key
        return f"FileService(base_url={self._base_url!r})"

    # ─── Operaciones de la API ───────────────────────────────────────────────

    def create_upload(
        self,
        name: str,
        mime_type: str,
        size: int,
        *,
        owner_ref: Optional[str] = None,
        visibility: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        actor: Optional[str] = None,
    ) -> CreatedUpload:
        """Inicia una subida. Devuelve el `id` y las instrucciones para subir los bytes directo
        al storage. Después hay que llamar a `complete()`. No se reintenta: repetirlo dejaría un
        archivo huérfano."""
        body: Dict[str, Any] = {"original_name": name, "mime_type": mime_type, "size_bytes": size}
        if owner_ref is not None:
            body["owner_ref"] = owner_ref
        if visibility is not None:
            body["visibility"] = visibility
        if metadata is not None:
            body["metadata"] = dict(metadata)
        raw = self._request("POST", "/files", body=body, actor=actor, idempotent=False)
        return CreatedUpload(id=raw["id"], status=raw["status"], upload=UploadInstructions.from_api(raw["upload"]))

    def sign_parts(self, id: str, part_numbers: Sequence[int], *, actor: Optional[str] = None) -> List[PartUrl]:
        """Subida multipart: firma las URLs de un lote de partes (hasta 100 por llamada)."""
        raw = self._request(
            "POST", f"/files/{self._seg(id)}/parts", body={"part_numbers": list(part_numbers)}, actor=actor
        )
        return [PartUrl(part_number=int(u["part_number"]), url=u["url"]) for u in raw["urls"]]

    def complete(
        self,
        id: str,
        parts: Optional[PartsInput] = None,
        *,
        wait: Union[bool, float] = False,
        actor: Optional[str] = None,
    ) -> FileInfo:
        """Cierra la subida: el servicio comprueba que los bytes estén en el storage y encola la
        verificación. Es idempotente.

        :param parts: requerido en multipart: las partes con sus ETags.
        :param wait: `True` espera (hasta 30 s) a que el archivo quede `AVAILABLE`; un número fija
            el tiempo máximo en segundos. Si termina en FAILED o QUARANTINED lanza `FileRejectedError`.
        """
        normalized = self._normalize_parts(parts)
        body = {"parts": [{"part_number": p.part_number, "etag": p.etag} for p in normalized]} if normalized else None
        file = FileInfo.from_api(self._request("POST", f"/files/{self._seg(id)}/complete", body=body, actor=actor))
        if wait is False or wait is None:
            return file
        timeout = 30.0 if wait is True else float(wait)
        return self.wait_until_available(id, timeout=timeout, actor=actor)

    def get(self, id: str, *, inline: bool = False, actor: Optional[str] = None) -> FileInfo:
        """Metadatos del archivo y, si está disponible, una URL firmada de descarga de vida corta.
        `inline=True` pide que el navegador lo muestre en vez de bajarlo (solo imágenes, video,
        audio y PDF; el resto siempre baja como adjunto)."""
        query = "?disposition=inline" if inline else ""
        return FileInfo.from_api(self._request("GET", f"/files/{self._seg(id)}{query}", actor=actor))

    def get_download_url(self, id: str, *, inline: bool = False, actor: Optional[str] = None) -> str:
        """Atajo: la URL firmada de descarga. Lanza `FileServiceError` (409) si no está disponible."""
        file = self.get(id, inline=inline, actor=actor)
        if file.download is None:
            raise FileServiceError(
                409, "invalid_state", f"el archivo no está disponible para descarga (estado {file.status})"
            )
        return file.download.url

    def wait_until_available(
        self, id: str, *, timeout: float = 30, interval: float = 0.5, actor: Optional[str] = None
    ) -> FileInfo:
        """Espera a que el worker termine de verificar el archivo (polling con backoff 0,5 s × 1,5
        hasta 3 s). Lanza `FileRejectedError` si lo rechaza y `FileServiceError` (`timeout`) si no
        termina a tiempo."""
        file, done = self._poll(id, timeout=timeout, interval=interval, actor=actor)
        if not done:
            raise FileServiceError(
                0,
                "timeout",
                f"el archivo sigue en {file.status}: la verificación no terminó a tiempo "
                "(sigue en curso; consultá más tarde o usá el webhook)",
            )
        return file

    def list(
        self,
        *,
        owner_ref: Optional[str] = None,
        status: Optional[str] = None,
        trashed: bool = False,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        actor: Optional[str] = None,
    ) -> FilePage:
        """Lista los archivos del Proyecto, del más nuevo al más viejo. No incluye URLs de descarga.
        `trashed=True` lista la papelera. `limit`: default 50, máximo 200."""
        q: Dict[str, str] = {}
        if owner_ref:
            q["owner_ref"] = owner_ref
        if status:
            q["status"] = status
        if trashed:
            q["trashed"] = "true"
        if cursor:
            q["cursor"] = cursor
        if limit:
            q["limit"] = str(int(limit))
        qs = urllib.parse.urlencode(q)
        raw = self._request("GET", "/files" + (f"?{qs}" if qs else ""), actor=actor)
        return FilePage(
            files=[FileInfo.from_api(f) for f in raw.get("files") or []],
            next_cursor=raw.get("next_cursor") or None,
        )

    def iter_all(
        self,
        *,
        owner_ref: Optional[str] = None,
        status: Optional[str] = None,
        trashed: bool = False,
        limit: Optional[int] = None,
        actor: Optional[str] = None,
    ) -> Iterator[FileInfo]:
        """Recorre todas las páginas de `list()`."""
        cursor: Optional[str] = None
        while True:
            page = self.list(
                owner_ref=owner_ref, status=status, trashed=trashed, cursor=cursor, limit=limit, actor=actor
            )
            yield from page.files
            cursor = page.next_cursor
            if not cursor:
                return

    def update(
        self,
        id: str,
        *,
        visibility: Optional[str] = None,
        name: Optional[str] = None,
        actor: Optional[str] = None,
    ) -> FileInfo:
        """Cambia la visibilidad y/o el nombre. Hacer público o privado un archivo es instantáneo."""
        body: Dict[str, Any] = {}
        if visibility is not None:
            body["visibility"] = visibility
        if name is not None:
            body["original_name"] = name
        return FileInfo.from_api(self._request("PATCH", f"/files/{self._seg(id)}", body=body, actor=actor))

    def delete(self, id: str, *, actor: Optional[str] = None) -> None:
        """Manda el archivo a la papelera. Se recupera con `restore()` durante la retención."""
        self._request("DELETE", f"/files/{self._seg(id)}", actor=actor)

    def restore(self, id: str, *, actor: Optional[str] = None) -> FileInfo:
        """Recupera un archivo de la papelera."""
        return FileInfo.from_api(self._request("POST", f"/files/{self._seg(id)}/restore", actor=actor))

    def upload(
        self,
        name: str,
        mime_type: str,
        data: UploadData,
        *,
        owner_ref: Optional[str] = None,
        visibility: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        actor: Optional[str] = None,
        wait: Union[bool, float] = True,
    ) -> FileInfo:
        """Sube un archivo desde el servidor (por ejemplo uno generado por el backend) y, por
        defecto, espera a que quede disponible.

        `data` puede ser `bytes`, una ruta (`str` / `PathLike`) o un archivo binario abierto. Con
        una ruta o un archivo, en multipart se lee una parte por vez: el archivo nunca se carga
        entero en memoria. Para archivos del usuario preferí `handle_upload()`: así los bytes no
        pasan por tu backend.
        """
        if isinstance(data, (bytes, bytearray, memoryview)):
            return self._upload_stream(
                name, mime_type, io.BytesIO(bytes(data)), len(data), owner_ref, visibility, metadata, actor, wait
            )
        if isinstance(data, (str, os.PathLike)):
            size = os.path.getsize(data)
            with open(data, "rb") as fh:
                return self._upload_stream(name, mime_type, fh, size, owner_ref, visibility, metadata, actor, wait)
        if hasattr(data, "read"):
            stream = data
            if stream.seekable():
                start = stream.tell()
                size = stream.seek(0, io.SEEK_END) - start
                stream.seek(start)
                stream = _OffsetReader(stream, start)  # type: ignore[assignment]
            else:
                # Sin seek no se puede saber el tamaño ni releer: se materializa en memoria.
                buf = stream.read()
                size = len(buf)
                stream = io.BytesIO(buf)
            return self._upload_stream(name, mime_type, stream, size, owner_ref, visibility, metadata, actor, wait)
        raise TypeError("upload: data debe ser bytes, una ruta o un archivo binario abierto")

    # ─── Webhooks ────────────────────────────────────────────────────────────

    @staticmethod
    def verify_webhook(
        payload: Union[str, bytes], signature: Optional[str], secret: str, tolerance: int = 300
    ) -> WebhookEvent:
        """Verifica la firma de un webhook y devuelve el evento.

        Pasá el body CRUDO (texto o bytes, sin parsear) y el header `FS-Signature`. Lanza
        `WebhookSignatureError` si la firma no coincide o el evento tiene más de `tolerance`
        segundos (protege contra reenvíos).
        """
        if not signature:
            raise WebhookSignatureError("falta el header FS-Signature")
        fields: Dict[str, str] = {}
        for kv in signature.split(","):
            k, sep, v = kv.strip().partition("=")
            if sep:
                fields[k.strip()] = v.strip()
        t_raw, v1 = fields.get("t", ""), fields.get("v1", "")
        try:
            t = int(t_raw)
        except ValueError:
            raise WebhookSignatureError("FS-Signature con formato inválido") from None
        if not v1:
            raise WebhookSignatureError("FS-Signature con formato inválido")

        body = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
        expected = hmac.new(secret.encode("utf-8"), f"{t}.".encode("ascii") + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected.encode("ascii"), v1.lower().encode("ascii", "replace")):
            raise WebhookSignatureError("la firma del webhook no coincide")
        if abs(time.time() - t) > tolerance:
            raise WebhookSignatureError("el evento es demasiado viejo")
        try:
            raw = json.loads(body.decode("utf-8"))
            return WebhookEvent(id=raw["id"], type=raw["type"], file=FileInfo.from_api(raw["data"]["file"]))
        except (ValueError, KeyError, TypeError) as exc:
            raise WebhookSignatureError(f"el payload del webhook no es válido: {exc}") from None

    # ─── Endpoint de subida del navegador (PROTOCOL.md) ──────────────────────

    def handle_upload(
        self,
        body: Union[Mapping[str, Any], str, bytes],
        owner_ref: str,
        *,
        visibility: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        wait_timeout: float = 30,
        actor: Optional[str] = None,
    ) -> UploadResult:
        """Implementa el endpoint de subida que usa `@ntropix/file-service/browser`.

        Montalo en UNA ruta `POST` de tu backend, después de autenticar al usuario: `owner_ref` es
        su id. `visibility` y `metadata` los fija el backend (la `metadata` del backend pisa, clave
        por clave, a la que mande el navegador). En `complete` espera la verificación hasta
        `wait_timeout` segundos; si vence, devuelve igual 200 con el archivo en `READY`.

        Nunca lanza: todo error se traduce a un `UploadResult` con `{"error": {"code", "message"}}`.
        `actor` (header `FS-Actor`) es por defecto el `owner_ref`.
        """
        try:
            return self._handle_upload(body, owner_ref, visibility, metadata, wait_timeout, actor)
        except FileRejectedError as exc:
            return UploadResult(exc.status, _error(exc.status, exc.code, exc.message), exc.file)
        except FileServiceError as exc:
            # Sin respuesta del File Service (0), o la API key del backend rechazada (401/403:
            # unauthorized / forbidden / project_disabled): es un problema del servidor, no del
            # usuario, así que nunca se propaga como 401/403 al navegador.
            if exc.status in (0, 401, 403):
                return UploadResult(502, _error(502, exc.code, exc.message))
            return UploadResult(exc.status, _error(exc.status, exc.code, exc.message))
        except _BadRequest as exc:
            return UploadResult(exc.status, _error(exc.status, exc.code, str(exc)))
        except Exception:  # noqa: BLE001 — el endpoint nunca debe romper con un 500 sin formato
            return UploadResult(500, _error(500, "internal", "error interno al procesar la subida"))

    def _handle_upload(
        self,
        body: Union[Mapping[str, Any], str, bytes],
        owner_ref: str,
        visibility: Optional[str],
        metadata: Optional[Mapping[str, Any]],
        wait_timeout: float,
        actor: Optional[str],
    ) -> UploadResult:
        if not isinstance(owner_ref, str) or not owner_ref:
            raise _BadRequest(401, "unauthorized", "no se pudo identificar al usuario")
        actor = actor or owner_ref
        req = _parse_body(body)
        action = req.get("action")

        if action == "create":
            name = _req_str(req, "name")
            mime_type = _req_str(req, "mimeType")
            size = req.get("size")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise _BadRequest(400, "validation", "size debe ser un entero ≥ 0")
            client_meta = req.get("metadata")
            if client_meta is not None and not isinstance(client_meta, dict):
                raise _BadRequest(400, "validation", "metadata debe ser un objeto")
            merged: Optional[Dict[str, Any]] = None
            if client_meta is not None or metadata is not None:
                merged = {**(client_meta or {}), **(dict(metadata) if metadata else {})}
            created = self.create_upload(
                name, mime_type, size, owner_ref=owner_ref, visibility=visibility, metadata=merged, actor=actor
            )
            token = create_upload_token(self._api_key, created.id, owner_ref, now=time.time())
            return UploadResult(200, {"id": created.id, "token": token, "upload": created.upload.to_dict()})

        if action == "parts":
            file_id = self._check_token(req, owner_ref)
            numbers = req.get("partNumbers")
            if (
                not isinstance(numbers, list)
                or not numbers
                or len(numbers) > _MAX_PARTS_PER_REQUEST
                or not all(isinstance(n, int) and not isinstance(n, bool) and n >= 1 for n in numbers)
            ):
                raise _BadRequest(400, "validation", "partNumbers debe ser una lista de 1 a 100 enteros ≥ 1")
            urls = self.sign_parts(file_id, numbers, actor=actor)
            return UploadResult(200, {"urls": [{"partNumber": u.part_number, "url": u.url} for u in urls]})

        if action == "complete":
            file_id = self._check_token(req, owner_ref)
            raw_parts = req.get("parts")
            parts: Optional[List[CompletedPart]] = None
            if raw_parts is not None:
                if not isinstance(raw_parts, list):
                    raise _BadRequest(400, "validation", "parts debe ser una lista")
                parts = []
                for p in raw_parts:
                    if not isinstance(p, dict):
                        raise _BadRequest(400, "validation", "cada parte debe ser {partNumber, etag}")
                    n, etag = p.get("partNumber"), p.get("etag")
                    if not isinstance(n, int) or isinstance(n, bool) or not isinstance(etag, str):
                        raise _BadRequest(400, "validation", "cada parte debe ser {partNumber, etag}")
                    parts.append(CompletedPart(n, etag))
            file = self.complete(file_id, parts, actor=actor)
            if wait_timeout and wait_timeout > 0:
                # Si la espera vence se devuelve el último estado (READY): la verificación sigue.
                file, _ = self._poll(file_id, timeout=wait_timeout, interval=0.5, actor=actor, first=file)
            return UploadResult(200, file.to_dict(), file)

        raise _BadRequest(400, "validation", f"action desconocida: {action!r} (create, parts o complete)")

    def _check_token(self, req: Mapping[str, Any], owner_ref: str) -> str:
        file_id = _req_str(req, "id")
        token = req.get("token")
        if not isinstance(token, str) or not verify_upload_token(
            self._api_key, token, file_id, owner_ref, now=time.time()
        ):
            raise _BadRequest(403, "forbidden", "token de subida inválido, vencido o de otro usuario")
        return file_id

    # ─── Internos ────────────────────────────────────────────────────────────

    @staticmethod
    def _seg(id: str) -> str:
        return urllib.parse.quote(str(id), safe="")

    @staticmethod
    def _normalize_parts(parts: Optional[PartsInput]) -> List[CompletedPart]:
        out: List[CompletedPart] = []
        for p in parts or []:
            n: Any
            etag: Any
            if isinstance(p, CompletedPart):
                n, etag = p.part_number, p.etag
            elif isinstance(p, Mapping):
                n = p.get("part_number", p.get("partNumber"))
                etag = p.get("etag")
            else:
                n, etag = p
            out.append(CompletedPart(int(n), _strip_quotes(str(etag))))
        return out

    def _poll(
        self,
        id: str,
        *,
        timeout: float,
        interval: float,
        actor: Optional[str],
        first: Optional[FileInfo] = None,
    ) -> Tuple[FileInfo, bool]:
        """Consulta hasta que el archivo quede AVAILABLE. Devuelve (archivo, terminó)."""
        deadline = time.monotonic() + timeout
        file = first
        while True:
            if file is None:
                file = self.get(id, actor=actor)
            if file.status == "AVAILABLE":
                return file, True
            if file.status in ("FAILED", "QUARANTINED"):
                raise FileRejectedError(file)
            if time.monotonic() + interval > deadline:
                return file, False
            self._sleep(interval)
            interval = min(interval * 1.5, 3.0)
            file = None

    def _upload_stream(
        self,
        name: str,
        mime_type: str,
        stream: BinaryIO,
        size: int,
        owner_ref: Optional[str],
        visibility: Optional[str],
        metadata: Optional[Mapping[str, Any]],
        actor: Optional[str],
        wait: Union[bool, float],
    ) -> FileInfo:
        created = self.create_upload(
            name, mime_type, size, owner_ref=owner_ref, visibility=visibility, metadata=metadata, actor=actor
        )
        up = created.upload
        parts: Optional[List[CompletedPart]] = None
        if up.mode == "simple":
            if not up.url:
                raise FileServiceError(0, "internal", "instrucciones de subida inválidas: falta la URL")

            def whole() -> BinaryIO:
                stream.seek(0)
                return stream

            self._put(up.url, whole, size, up.headers)
        else:
            if not up.part_size or not up.part_count:
                raise FileServiceError(0, "internal", "instrucciones de subida inválidas: faltan las partes")
            part_size = up.part_size
            parts = []
            numbers = list(range(1, up.part_count + 1))
            for i in range(0, len(numbers), _MAX_PARTS_PER_REQUEST):
                for signed in self.sign_parts(created.id, numbers[i : i + _MAX_PARTS_PER_REQUEST], actor=actor):
                    offset = (signed.part_number - 1) * part_size
                    stream.seek(offset)
                    chunk = stream.read(min(part_size, size - offset))  # una parte por vez en memoria
                    etag = self._put(signed.url, _bytes_body(chunk), len(chunk), None)
                    parts.append(CompletedPart(signed.part_number, etag))
        return self.complete(created.id, parts, wait=wait, actor=actor)

    def _put(
        self,
        url: str,
        body: Callable[[], BinaryIO],
        length: int,
        headers: Optional[Mapping[str, str]],
    ) -> str:
        """PUT de bytes a una URL firmada del storage. Devuelve el ETag. Repetir un PUT es seguro."""
        hdrs = {"Content-Length": str(length), "Content-Type": "application/octet-stream"}
        hdrs.update(headers or {})
        attempts = self._retries + 1
        for attempt in range(1, attempts + 1):
            req = urllib.request.Request(url, data=body(), headers=hdrs, method="PUT")
            try:
                with urllib.request.urlopen(req, timeout=max(self._timeout, 120)) as res:
                    return _strip_quotes(res.headers.get("ETag") or "")
            except urllib.error.HTTPError as exc:
                err = FileServiceError(
                    exc.code, "storage_rejected", f"el storage rechazó la subida (HTTP {exc.code})"
                )
                exc.close()
                if exc.code < 500 or attempt == attempts:
                    raise err from None
            except (urllib.error.URLError, OSError) as exc:
                if attempt == attempts:
                    raise FileServiceError(0, "network", f"no se pudo subir al storage: {_reason(exc)}") from None
            self._sleep(0.25 * 2 ** (attempt - 1))
        raise AssertionError("inalcanzable")  # pragma: no cover

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, Any]] = None,
        actor: Optional[str] = None,
        idempotent: bool = True,
    ) -> Any:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
        }
        if actor:
            headers["FS-Actor"] = actor
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        # Solo se reintenta lo que es seguro repetir: crear un archivo dos veces dejaría uno huérfano.
        attempts = self._retries + 1 if idempotent else 1
        last: Optional[FileServiceError] = None
        for attempt in range(1, attempts + 1):
            req = urllib.request.Request(self._base_url + path, data=data, headers=headers, method=method)
            retry_after: Optional[float] = None
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as res:
                    text = res.read()
                    if res.status == 204 or not text:
                        return None
                    return json.loads(text)
            except urllib.error.HTTPError as exc:
                status = exc.code
                try:
                    payload = json.loads(exc.read() or b"null")
                except (ValueError, OSError):
                    payload = None
                retry_after = _parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None)
                exc.close()
                err_obj = payload.get("error") if isinstance(payload, dict) else None
                err_obj = err_obj if isinstance(err_obj, dict) else {}
                last = FileServiceError(
                    status,
                    str(err_obj.get("code") or "internal"),
                    str(err_obj.get("message") or f"respuesta inesperada del File Service (HTTP {status})"),
                )
                if not (status == 429 or status >= 500):
                    raise last from None
            except (socket.timeout, TimeoutError):
                last = FileServiceError(0, "timeout", f"el File Service no respondió en {self._timeout} s")
            except urllib.error.URLError as exc:
                if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                    last = FileServiceError(0, "timeout", f"el File Service no respondió en {self._timeout} s")
                else:
                    last = FileServiceError(0, "network", f"no se pudo conectar con el File Service: {_reason(exc)}")
            except (OSError, ValueError) as exc:  # conexión cortada, JSON inválido…
                last = FileServiceError(0, "network", f"no se pudo conectar con el File Service: {_reason(exc)}")
            if attempt < attempts:
                self._sleep(retry_after if retry_after is not None else 0.25 * 2 ** (attempt - 1))
        assert last is not None
        raise last


class _OffsetReader(io.RawIOBase):
    """Vista de un archivo abierto que empieza en `start` (seek relativo a esa posición)."""

    def __init__(self, inner: BinaryIO, start: int) -> None:
        super().__init__()
        self._inner = inner
        self._start = start

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            return self._inner.seek(self._start + offset) - self._start
        return self._inner.seek(offset, whence) - self._start

    def tell(self) -> int:
        return self._inner.tell() - self._start

    def read(self, size: int = -1) -> bytes:
        return self._inner.read(size)

    def readinto(self, b: Any) -> int:
        data = self._inner.read(len(b))
        b[: len(data)] = data
        return len(data)


class _BadRequest(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _bytes_body(chunk: bytes) -> Callable[[], BinaryIO]:
    return lambda: io.BytesIO(chunk)


def _parse_body(body: Union[Mapping[str, Any], str, bytes]) -> Mapping[str, Any]:
    if isinstance(body, (bytes, bytearray)):
        try:
            body = bytes(body).decode("utf-8")
        except UnicodeDecodeError:
            raise _BadRequest(400, "validation", "el body no es UTF-8 válido") from None
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            raise _BadRequest(400, "validation", "el body no es JSON válido") from None
    if not isinstance(body, Mapping):
        raise _BadRequest(400, "validation", "el body debe ser un objeto JSON")
    return body


def _req_str(req: Mapping[str, Any], key: str) -> str:
    v = req.get(key)
    if not isinstance(v, str) or not v:
        raise _BadRequest(400, "validation", f"falta {key} o no es un texto")
    return v


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        secs = float(value)
    except ValueError:
        return None
    return min(secs, 60.0) if secs > 0 else None


def _reason(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    return str(reason if reason is not None else exc)
