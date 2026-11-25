<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Uso del Proyecto contra su Cuota y límites de su Política (`usage()`).
 */
final class Usage
{
    /**
     * @param int          $usedBytes        Bytes ocupados (incluye subidas en curso).
     * @param int          $quotaBytes       Cuota de almacenamiento; 0 = sin cuota.
     * @param int          $fileCount        Archivos vivos (fuera de la papelera).
     * @param int          $maxFileSize      Tamaño máximo por archivo, en bytes.
     * @param list<string> $allowedMimeTypes Tipos admitidos (admite `image/*`); vacío = cualquiera.
     */
    public function __construct(
        public readonly int $usedBytes,
        public readonly int $quotaBytes,
        public readonly int $fileCount,
        public readonly int $maxFileSize,
        public readonly array $allowedMimeTypes,
    ) {
    }

    /**
     * @param array<string, mixed> $raw
     *
     * @internal
     */
    public static function fromApi(array $raw): self
    {
        return new self(
            (int) ($raw['used_bytes'] ?? 0),
            (int) ($raw['quota_bytes'] ?? 0),
            (int) ($raw['file_count'] ?? 0),
            (int) ($raw['max_file_size'] ?? 0),
            array_values(array_map('strval', (array) ($raw['allowed_mime_types'] ?? []))),
        );
    }
}
