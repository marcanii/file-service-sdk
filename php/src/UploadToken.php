<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Token de subida del protocolo navegador↔backend (sdk/PROTOCOL.md): prueba sin estado de que el
 * `id` lo creó ese `ownerRef`.
 *
 *   token = "<exp>.<hex(HMAC-SHA256(apiKey, "fs-upload-token.v1:<id>:<ownerRef>:<exp>"))>"
 *
 * Lo usa `FileService::handleUpload()`; es público para los tests de vectores compartidos.
 */
final class UploadToken
{
    /** Vida del token en segundos (igual que `ABANDONED_UPLOAD_TIMEOUT`). */
    public const TTL = 86400;

    public static function sign(string $apiKey, string $id, string $ownerRef, int $exp): string
    {
        return $exp . '.' . self::mac($apiKey, $id, $ownerRef, $exp);
    }

    /**
     * Valida el token contra el `ownerRef` del usuario autenticado en ESTE request.
     * Falso si el formato es inválido, si venció (`exp <= now`) o si la firma no coincide.
     */
    public static function verify(string $apiKey, string $token, string $id, string $ownerRef, int $now): bool
    {
        if (preg_match('/^([0-9]{1,19})\.([0-9a-fA-F]{64})$/D', $token, $m) !== 1) {
            return false;
        }
        $exp = (int) $m[1];
        if ($exp <= $now) {
            return false;
        }

        return hash_equals(self::mac($apiKey, $id, $ownerRef, $exp), strtolower($m[2]));
    }

    private static function mac(string $apiKey, string $id, string $ownerRef, int $exp): string
    {
        return hash_hmac('sha256', "fs-upload-token.v1:{$id}:{$ownerRef}:{$exp}", $apiKey);
    }
}
