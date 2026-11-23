<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Una página de `list()`. `nextCursor` es `null` en la última página.
 */
final class FilePage
{
    /**
     * @param list<FileInfo> $files
     */
    public function __construct(
        public readonly array $files,
        public readonly ?string $nextCursor,
    ) {
    }
}
