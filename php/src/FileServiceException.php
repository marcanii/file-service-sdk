<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Error devuelto por el File Service (o por la red al hablar con él).
 *
 * `errorCode` es estable y sirve para decidir qué hacer: `unauthorized` · `forbidden` ·
 * `project_disabled` · `not_found` · `validation` · `invalid_state` · `no_bytes` · `too_large` ·
 * `type_not_allowed` · `quota_exceeded` · `storage_full` · `rate_limited` · `internal` ·
 * `storage_rejected` · `network` · `timeout`.
 *
 * `getCode()` devuelve el mismo valor que `status`.
 */
class FileServiceException extends \RuntimeException
{
    /**
     * @param int         $status    Status HTTP (0 si no hubo respuesta).
     * @param string      $errorCode Código estable del error.
     * @param string      $message   Mensaje legible (en español).
     * @param string|null $requestId `X-Request-ID` de la respuesta: incluilo al reportar un
     *                               problema. `null` si no hubo respuesta (`network`, `timeout`).
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        ?\Throwable $previous = null,
        public readonly ?string $requestId = null,
    ) {
        parent::__construct($message, $status, $previous);
    }
}
