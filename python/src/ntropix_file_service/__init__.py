"""SDK de Python del File Service de ntropix.

    from ntropix_file_service import FileService

    fs = FileService(api_key=os.environ["FS_API_KEY"], base_url="https://files.ntropix.dev")
    result = fs.handle_upload(request_body, owner_ref=user.id)   # endpoint de subida del navegador
    file = fs.get(file_id)                                         # metadatos + URL de descarga
"""

from .client import FileService
from .errors import FileRejectedError, FileServiceError, WebhookSignatureError
from .models import (
    CompletedPart,
    CreatedUpload,
    DownloadInfo,
    FileInfo,
    FilePage,
    FileStatus,
    PartUrl,
    UploadInstructions,
    UploadResult,
    Usage,
    Visibility,
    WebhookEvent,
    WebhookEventType,
)

from ._version import __version__  # noqa: E402

__all__ = [
    "FileService",
    "FileServiceError",
    "FileRejectedError",
    "WebhookSignatureError",
    "FileInfo",
    "FilePage",
    "Usage",
    "DownloadInfo",
    "UploadInstructions",
    "CreatedUpload",
    "PartUrl",
    "CompletedPart",
    "WebhookEvent",
    "UploadResult",
    "FileStatus",
    "Visibility",
    "WebhookEventType",
    "__version__",
]
