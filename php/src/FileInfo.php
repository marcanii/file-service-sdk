<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Un file tal como lo ve el Proyecto. Inmutable.
 */
final class FileInfo
{
    /**
     * @param array<string, mixed>                       $metadata Datos propios del Proyecto.
     * @param array{url: string, expiresAt: string}|null $download URL firmada de descarga de vida
     *        corta. Solo viene en `get()` y si el file está `AVAILABLE` y fuera de la papelera.
     */
    public function __construct(
        public readonly string $id,
        /** Slug del Proyecto dueño. */
        public readonly string $project,
        public readonly FileStatus $status,
        public readonly string $name,
        /** Tipo declarado al subir; una vez `AVAILABLE`, el tipo REAL detectado por el servicio. */
        public readonly string $mimeType,
        public readonly int $size,
        /** SHA-256 del contenido (cuando ya fue verificado). */
        public readonly ?string $contentHash,
        /** Id del Usuario final en tu sistema, si se informó al subir. */
        public readonly ?string $ownerRef,
        public readonly Visibility $visibility,
        /** URL estable para files públicos y disponibles (sirve directo en un `<img src>`). */
        public readonly ?string $publicUrl,
        public readonly array $metadata,
        public readonly string $createdAt,
        /** Presente si el file está en la papelera. */
        public readonly ?string $deletedAt,
        public readonly ?array $download,
    ) {
    }

    /**
     * Construye un FileInfo desde la respuesta de la API (snake_case).
     *
     * @param array<string, mixed> $raw
     * @internal
     */
    public static function fromApi(array $raw): self
    {
        $download = null;
        if (isset($raw['download']) && is_array($raw['download']) && isset($raw['download']['url'])) {
            $download = [
                'url' => (string) $raw['download']['url'],
                'expiresAt' => (string) ($raw['download']['expires_at'] ?? ''),
            ];
        }
        $status = FileStatus::tryFrom((string) ($raw['status'] ?? ''));
        if ($status === null) {
            throw new FileServiceException(
                0,
                'internal',
                'estado de file desconocido en la respuesta del File Service',
            );
        }

        return new self(
            id: (string) ($raw['id'] ?? ''),
            project: (string) ($raw['project'] ?? ''),
            status: $status,
            name: (string) ($raw['original_name'] ?? ''),
            mimeType: (string) ($raw['mime_type'] ?? ''),
            size: (int) ($raw['size_bytes'] ?? 0),
            contentHash: self::optString($raw['content_hash'] ?? null),
            ownerRef: self::optString($raw['owner_ref'] ?? null),
            visibility: Visibility::tryFrom((string) ($raw['visibility'] ?? '')) ?? Visibility::Private,
            publicUrl: self::optString($raw['public_url'] ?? null),
            metadata: is_array($raw['metadata'] ?? null) ? $raw['metadata'] : [],
            createdAt: (string) ($raw['created_at'] ?? ''),
            deletedAt: self::optString($raw['deleted_at'] ?? null),
            download: $download,
        );
    }

    /** `true` si se puede descargar ya (`AVAILABLE`). */
    public function isAvailable(): bool
    {
        return $this->status === FileStatus::Available;
    }

    /**
     * Representación camelCase del protocolo (sdk/PROTOCOL.md), lista para `json_encode`.
     * Los campos opcionales ausentes se omiten; `metadata` vacía se emite como `{}`.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = [
            'id' => $this->id,
            'project' => $this->project,
            'status' => $this->status->value,
            'name' => $this->name,
            'mimeType' => $this->mimeType,
            'size' => $this->size,
            'contentHash' => $this->contentHash,
            'ownerRef' => $this->ownerRef,
            'visibility' => $this->visibility->value,
            'publicUrl' => $this->publicUrl,
            'metadata' => $this->metadata === [] ? new \stdClass() : $this->metadata,
            'createdAt' => $this->createdAt,
            'deletedAt' => $this->deletedAt,
            'download' => $this->download,
        ];

        return array_filter($out, static fn (mixed $v): bool => $v !== null);
    }

    private static function optString(mixed $v): ?string
    {
        return is_string($v) && $v !== '' ? $v : null;
    }
}
