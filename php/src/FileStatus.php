<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Estados del ciclo de vida de un file. Solo `AVAILABLE` es descargable.
 */
enum FileStatus: string
{
    case Pending = 'PENDING';
    case Uploading = 'UPLOADING';
    case Ready = 'READY';
    case Available = 'AVAILABLE';
    case Failed = 'FAILED';
    case Quarantined = 'QUARANTINED';
    /** Estado que este SDK no conoce (el servicio agregó uno nuevo): no es final ni descargable. */
    case Unknown = 'UNKNOWN';

    /** `true` si el worker ya terminó de verificar el file (aceptado o rechazado). */
    public function isFinal(): bool
    {
        return $this === self::Available || $this === self::Failed || $this === self::Quarantined;
    }
}
