<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * El file se subió pero el servicio lo rechazó al verificarlo: `FAILED` (corrupto o incompleto)
 * o `QUARANTINED` (su tipo real no está permitido). Status 422, `errorCode` `failed` o `quarantined`.
 *
 * El file rechazado está en `$fileInfo` (`$file` ya lo usa `\Exception` para la ruta del fuente).
 */
final class FileRejectedException extends FileServiceException
{
    public function __construct(public readonly FileInfo $fileInfo)
    {
        $quarantined = $fileInfo->status === FileStatus::Quarantined;
        parent::__construct(
            422,
            $quarantined ? 'quarantined' : 'failed',
            $quarantined
                ? "el archivo quedó en cuarentena: su tipo real ({$fileInfo->mimeType}) no está permitido"
                : 'el archivo no pasó la verificación (corrupto o incompleto)',
        );
    }
}
