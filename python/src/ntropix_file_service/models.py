"""Tipos públicos del SDK.

La API habla snake_case (`original_name`, `size_bytes`…); el SDK expone atributos Python en
snake_case con nombres cortos (`name`, `size`…) y, para el protocolo de subida del navegador,
serializa a camelCase con `to_dict()` (ver `sdk/PROTOCOL.md`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Mapping, Optional

__all__ = [
    "FileStatus",
    "Visibility",
    "WebhookEventType",
    "DownloadInfo",
    "FileInfo",
    "FilePage",
    "Usage",
    "UploadInstructions",
    "CreatedUpload",
    "PartUrl",
    "CompletedPart",
    "WebhookEvent",
    "UploadResult",
]

#: Estados del ciclo de vida de un archivo. Solo `AVAILABLE` es descargable.
FileStatus = Literal["PENDING", "UPLOADING", "READY", "AVAILABLE", "FAILED", "QUARANTINED"]

#: `private` (default) o `public` (URL estable para quien tenga el link).
Visibility = Literal["private", "public"]

WebhookEventType = Literal["file.available", "file.failed", "file.quarantined"]


def _drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


@dataclass(frozen=True)
class DownloadInfo:
    """URL firmada de descarga de vida corta."""

    url: str
    expires_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {"url": self.url, "expiresAt": self.expires_at}


@dataclass(frozen=True)
class FileInfo:
    """Un archivo tal como lo ve el Proyecto."""

    id: str
    #: Slug del Proyecto dueño.
    project: str
    status: FileStatus
    name: str
    #: Tipo declarado al subir; una vez `AVAILABLE`, el tipo REAL detectado por el servicio.
    mime_type: str
    size: int
    visibility: Visibility
    created_at: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    #: SHA-256 del contenido (cuando ya fue verificado).
    content_hash: Optional[str] = None
    #: Id del Usuario final en tu sistema, si lo informaste al subir.
    owner_ref: Optional[str] = None
    #: URL estable de un archivo público y disponible (sirve directo en un `<img src>`).
    public_url: Optional[str] = None
    #: Presente si el archivo está en la papelera.
    deleted_at: Optional[str] = None
    #: Solo viene en `get()` y si el archivo está disponible.
    download: Optional[DownloadInfo] = None
    #: Motivo del fallo o la cuarentena. Solo viene en los Eventos `file.failed` y `file.quarantined`.
    reason: Optional[str] = None

    @classmethod
    def from_api(cls, raw: Mapping[str, Any]) -> "FileInfo":
        """Convierte la respuesta snake_case de la API."""
        dl = raw.get("download")
        return cls(
            id=raw["id"],
            project=raw.get("project") or "",
            status=raw["status"],  # type: ignore[arg-type]
            name=raw.get("original_name") or "",
            mime_type=raw.get("mime_type") or "",
            size=int(raw.get("size_bytes") or 0),
            visibility=raw.get("visibility") or "private",  # type: ignore[arg-type]
            created_at=raw.get("created_at") or "",
            metadata=dict(raw.get("metadata") or {}),
            content_hash=raw.get("content_hash") or None,
            owner_ref=raw.get("owner_ref") or None,
            public_url=raw.get("public_url") or None,
            deleted_at=raw.get("deleted_at") or None,
            download=DownloadInfo(url=dl["url"], expires_at=dl.get("expires_at") or "") if dl else None,
            reason=raw.get("reason") or None,
        )

    def to_dict(self) -> Dict[str, Any]:
        """Forma camelCase del protocolo de subida (la que recibe el navegador)."""
        return _drop_none(
            {
                "id": self.id,
                "project": self.project,
                "status": self.status,
                "name": self.name,
                "mimeType": self.mime_type,
                "size": self.size,
                "contentHash": self.content_hash,
                "ownerRef": self.owner_ref,
                "visibility": self.visibility,
                "publicUrl": self.public_url,
                "metadata": self.metadata,
                "createdAt": self.created_at,
                "deletedAt": self.deleted_at,
                "download": self.download.to_dict() if self.download else None,
            }
        )


@dataclass(frozen=True)
class FilePage:
    """Una página de `list()`. `next_cursor` es `None` en la última."""

    files: List[FileInfo]
    next_cursor: Optional[str] = None


@dataclass(frozen=True)
class Usage:
    """Uso del Proyecto contra su Cuota y límites de su Política (`usage()`)."""

    used_bytes: int  # incluye subidas en curso
    quota_bytes: int  # 0 = sin cuota
    file_count: int  # archivos vivos (fuera de la papelera)
    max_file_size: int
    allowed_mime_types: List[str]  # vacío = cualquier tipo; admite "image/*"

    @staticmethod
    def from_api(raw: Mapping[str, Any]) -> "Usage":
        return Usage(
            used_bytes=int(raw["used_bytes"]),
            quota_bytes=int(raw["quota_bytes"]),
            file_count=int(raw["file_count"]),
            max_file_size=int(raw["max_file_size"]),
            allowed_mime_types=list(raw.get("allowed_mime_types") or []),
        )


@dataclass(frozen=True)
class UploadInstructions:
    """Instrucciones para subir los bytes directo al storage."""

    mode: str  # "simple" | "multipart"
    expires_at: str
    #: simple: URL firmada para un único PUT.
    url: Optional[str] = None
    #: simple: headers que el PUT debe llevar.
    headers: Optional[Dict[str, str]] = None
    #: multipart: tamaño de cada parte (la última puede ser menor).
    part_size: Optional[int] = None
    #: multipart: cantidad de partes.
    part_count: Optional[int] = None

    @classmethod
    def from_api(cls, raw: Mapping[str, Any]) -> "UploadInstructions":
        return cls(
            mode=raw["mode"],
            expires_at=raw.get("expires_at") or "",
            url=raw.get("url") or None,
            headers=dict(raw["headers"]) if raw.get("headers") else None,
            part_size=raw.get("part_size") or None,
            part_count=raw.get("part_count") or None,
        )

    def to_dict(self) -> Dict[str, Any]:
        """Forma camelCase del protocolo de subida."""
        return _drop_none(
            {
                "mode": self.mode,
                "url": self.url,
                "headers": self.headers,
                "partSize": self.part_size,
                "partCount": self.part_count,
                "expiresAt": self.expires_at,
            }
        )


@dataclass(frozen=True)
class CreatedUpload:
    """Resultado de `create_upload()`."""

    id: str
    status: FileStatus
    upload: UploadInstructions


@dataclass(frozen=True)
class PartUrl:
    part_number: int
    url: str


@dataclass(frozen=True)
class CompletedPart:
    """Una parte ya subida: su número y el ETag que devolvió el storage."""

    part_number: int
    etag: str


@dataclass(frozen=True)
class WebhookEvent:
    """Evento que el File Service envía al webhook del Proyecto."""

    #: Id único del evento: usalo para descartar duplicados (la entrega es at-least-once).
    id: str
    type: WebhookEventType
    file: FileInfo


@dataclass(frozen=True)
class UploadResult:
    """Respuesta de `handle_upload()`: devolvela tal cual con el framework web.

    `status` es el código HTTP y `body` el JSON a enviar. `file` está presente cuando la
    operación terminó en un archivo (complete, incluido el rechazo 422).
    """

    status: int
    body: Dict[str, Any]
    file: Optional[FileInfo] = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300
