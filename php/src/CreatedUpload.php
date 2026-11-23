<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Resultado de `createUpload()`: el id del file y cómo subir sus bytes.
 */
final class CreatedUpload
{
    public function __construct(
        public readonly string $id,
        public readonly FileStatus $status,
        public readonly UploadInstructions $upload,
    ) {
    }
}
