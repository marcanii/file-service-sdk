<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Instrucciones para que el navegador suba los bytes directo al storage.
 */
final class UploadInstructions
{
    /**
     * @param 'simple'|'multipart'  $mode
     * @param array<string, string> $headers simple: headers que el PUT debe llevar.
     */
    public function __construct(
        public readonly string $mode,
        /** simple: URL firmada para un único PUT. */
        public readonly ?string $url,
        public readonly array $headers,
        /** multipart: tamaño de cada parte (la última puede ser menor). */
        public readonly ?int $partSize,
        /** multipart: cantidad de partes. */
        public readonly ?int $partCount,
        public readonly string $expiresAt,
    ) {
    }

    /**
     * @param array<string, mixed> $raw
     * @internal
     */
    public static function fromApi(array $raw): self
    {
        $headers = [];
        foreach ((array) ($raw['headers'] ?? []) as $k => $v) {
            $headers[(string) $k] = (string) $v;
        }

        return new self(
            mode: ($raw['mode'] ?? '') === 'multipart' ? 'multipart' : 'simple',
            url: isset($raw['url']) && $raw['url'] !== '' ? (string) $raw['url'] : null,
            headers: $headers,
            partSize: isset($raw['part_size']) && $raw['part_size'] ? (int) $raw['part_size'] : null,
            partCount: isset($raw['part_count']) && $raw['part_count'] ? (int) $raw['part_count'] : null,
            expiresAt: (string) ($raw['expires_at'] ?? ''),
        );
    }

    public function isMultipart(): bool
    {
        return $this->mode === 'multipart';
    }

    /**
     * Representación camelCase del protocolo (sdk/PROTOCOL.md).
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        if ($this->isMultipart()) {
            return [
                'mode' => 'multipart',
                'partSize' => $this->partSize,
                'partCount' => $this->partCount,
                'expiresAt' => $this->expiresAt,
            ];
        }

        return [
            'mode' => 'simple',
            'url' => $this->url,
            'headers' => $this->headers === [] ? new \stdClass() : $this->headers,
            'expiresAt' => $this->expiresAt,
        ];
    }
}
