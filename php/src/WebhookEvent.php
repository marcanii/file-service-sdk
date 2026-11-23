<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Evento que el File Service envía al webhook del Proyecto (ya verificado).
 */
final class WebhookEvent
{
    public const FILE_AVAILABLE = 'file.available';
    public const FILE_FAILED = 'file.failed';
    public const FILE_QUARANTINED = 'file.quarantined';

    public function __construct(
        /** Id único del evento: usalo para descartar duplicados (la entrega es at-least-once). */
        public readonly string $id,
        /** `file.available` · `file.failed` · `file.quarantined`. */
        public readonly string $type,
        public readonly FileInfo $file,
    ) {
    }
}
