"""Errores del SDK."""

from __future__ import annotations

from .models import FileInfo

__all__ = ["FileServiceError", "FileRejectedError", "WebhookSignatureError"]


class FileServiceError(Exception):
    """Error devuelto por la API (o al hablar con ella). `code` es estable y sirve para decidir.

    `status` es el HTTP (0 si no hubo respuesta). Códigos: `unauthorized` · `forbidden` ·
    `project_disabled` · `not_found` · `validation` · `invalid_state` · `no_bytes` · `too_large` ·
    `type_not_allowed` · `quota_exceeded` · `storage_full` · `rate_limited` · `internal` ·
    `storage_rejected` · `network` · `timeout`.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status!r}, code={self.code!r}, message={self.message!r})"


class FileRejectedError(FileServiceError):
    """El archivo se subió pero el servicio lo rechazó al verificarlo (FAILED o QUARANTINED)."""

    def __init__(self, file: FileInfo) -> None:
        if file.status == "QUARANTINED":
            code = "quarantined"
            message = f"el archivo quedó en cuarentena: su tipo real ({file.mime_type}) no está permitido"
        else:
            code = "failed"
            message = "el archivo no pasó la verificación (corrupto o incompleto)"
        super().__init__(422, code, message)
        self.file = file


class WebhookSignatureError(Exception):
    """La firma del webhook no es válida, o el evento es demasiado viejo."""
