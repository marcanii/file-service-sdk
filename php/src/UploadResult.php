<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Respuesta de `handleUpload()` lista para devolver al navegador.
 *
 * `body` es el JSON del protocolo (los objetos vacíos vienen como `stdClass` para que cualquier
 * encoder los emita como `{}`). `file` viene en un `complete` exitoso (200) y también en un 422
 * (file rechazado: para el backend; el navegador solo recibe el error).
 */
final class UploadResult
{
    /**
     * @param array<string, mixed> $body
     */
    public function __construct(
        public readonly int $status,
        public readonly array $body,
        public readonly ?FileInfo $file = null,
    ) {
    }

    /** @internal */
    public static function error(int $status, string $code, string $message, ?FileInfo $file = null): self
    {
        return new self($status, ['error' => ['code' => $code, 'message' => $message]], $file);
    }

    /** `true` si el status es 2xx. */
    public function isOk(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    /**
     * El body para pasárselo al helper JSON del framework (`response()->json(...)`, `JsonResponse`…).
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return $this->body;
    }

    /** El body serializado como JSON. */
    public function json(): string
    {
        $json = json_encode(
            $this->body,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE,
        );

        return $json === false ? '{"error":{"code":"internal","message":"no se pudo serializar la respuesta"}}' : $json;
    }

    /**
     * Emite la respuesta en PHP plano: status HTTP, `Content-Type: application/json` y el body.
     */
    public function send(): void
    {
        if (!headers_sent()) {
            http_response_code($this->status);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo $this->json();
    }
}
