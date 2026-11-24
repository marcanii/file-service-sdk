<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Cliente de servidor del File Service de ntropix.
 *
 * Se usa SOLO en el backend del Proyecto: la API key nunca debe llegar al navegador. El navegador
 * recibe únicamente instrucciones de subida (URLs firmadas) a través de `handleUpload()`.
 *
 *   $fs = new FileService(getenv('FILE_SERVICE_KEY'), 'https://files.ntropix.dev');
 *   $file = $fs->get($id);
 */
final class FileService
{
    private const MAX_PARTS_PER_BATCH = 100;
    private const MAX_RETRY_AFTER = 60.0;

    private readonly string $baseUrl;

    /** @var \Closure(): int */
    private readonly \Closure $clock;

    /**
     * @param string        $apiKey  API key del Proyecto (`fsk_live_...` / `fsk_test_...`).
     * @param string        $baseUrl URL de la API, ej. `https://files.ntropix.dev`.
     * @param float         $timeout Tiempo máximo por request, en segundos.
     * @param int           $retries Reintentos ante red, 429 y 5xx en operaciones seguras de repetir.
     * @param \Closure|null $clock   Reloj (segundos Unix) para el token de subida. Solo para tests.
     */
    public function __construct(
        private readonly string $apiKey,
        string $baseUrl,
        private readonly float $timeout = 30,
        private readonly int $retries = 2,
        ?\Closure $clock = null,
    ) {
        if ($apiKey === '') {
            throw new \InvalidArgumentException('FileService: falta apiKey');
        }
        if ($baseUrl === '') {
            throw new \InvalidArgumentException('FileService: falta baseUrl');
        }
        if (!extension_loaded('curl')) {
            throw new \RuntimeException('FileService: requiere la extensión curl');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->clock = $clock ?? static fn (): int => time();
    }

    // ─── Subida ──────────────────────────────────────────────────────────────

    /**
     * Inicia una subida. Devuelve el `id` del file y las instrucciones que el navegador necesita
     * para subir los bytes directo al storage. Después hay que llamar a `complete()`.
     * No se reintenta: repetir un create dejaría un file huérfano.
     *
     * @param string               $name     Nombre original del file (sin rutas).
     * @param string               $mimeType Tipo declarado; el servicio verifica después el real.
     * @param int                  $size     Tamaño exacto en bytes.
     * @param string|null          $ownerRef Id del Usuario final en tu sistema.
     * @param array<string, mixed> $metadata Datos propios del Proyecto (JSON, hasta 16 KB).
     * @param string|null          $actor    Usuario final que origina la acción (header `FS-Actor`).
     *
     * @throws FileServiceException
     */
    public function createUpload(
        string $name,
        string $mimeType,
        int $size,
        ?string $ownerRef = null,
        Visibility|string|null $visibility = null,
        array $metadata = [],
        ?string $actor = null,
    ): CreatedUpload {
        $raw = $this->request('POST', '/files', [
            'original_name' => $name,
            'mime_type' => $mimeType,
            'size_bytes' => $size,
            'owner_ref' => $ownerRef,
            'visibility' => $visibility instanceof Visibility ? $visibility->value : $visibility,
            'metadata' => $metadata === [] ? null : $metadata,
        ], $actor, idempotent: false);

        return new CreatedUpload(
            (string) ($raw['id'] ?? ''),
            FileStatus::tryFrom((string) ($raw['status'] ?? '')) ?? FileStatus::Pending,
            UploadInstructions::fromApi((array) ($raw['upload'] ?? [])),
        );
    }

    /**
     * Subida multipart: firma las URLs de un lote de partes (hasta 100 por llamada).
     *
     * @param list<int> $partNumbers
     * @return array<int, string> número de parte → URL firmada para el PUT.
     *
     * @throws FileServiceException
     */
    public function signParts(string $id, array $partNumbers, ?string $actor = null): array
    {
        $raw = $this->request('POST', '/files/' . rawurlencode($id) . '/parts', [
            'part_numbers' => array_values(array_map('intval', $partNumbers)),
        ], $actor);
        $urls = [];
        foreach ((array) ($raw['urls'] ?? []) as $u) {
            $urls[(int) $u['part_number']] = (string) $u['url'];
        }

        return $urls;
    }

    /**
     * Cierra la subida: el servicio comprueba que los bytes estén en el storage y encola la
     * verificación. Es idempotente.
     *
     * @param list<array{partNumber: int, etag: string}> $parts Requerido en multipart.
     * @param bool|float $wait `true` espera hasta 30 s a que quede `AVAILABLE`; un float es el
     *        máximo en segundos. Si el file termina rechazado lanza `FileRejectedException`.
     *
     * @throws FileServiceException
     */
    public function complete(string $id, array $parts = [], bool|float $wait = false, ?string $actor = null): FileInfo
    {
        $body = null;
        if ($parts !== []) {
            $body = ['parts' => array_map(static fn (array $p): array => [
                'part_number' => (int) ($p['partNumber'] ?? $p['part_number'] ?? 0),
                'etag' => trim((string) ($p['etag'] ?? ''), '"'),
            ], array_values($parts))];
        }
        $raw = $this->request('POST', '/files/' . rawurlencode($id) . '/complete', $body, $actor);
        $file = FileInfo::fromApi($raw ?? []);
        if ($wait === false) {
            return $file;
        }

        return $this->waitUntilAvailable($id, $wait === true ? 30.0 : (float) $wait, actor: $actor);
    }

    /**
     * Sube un file desde el servidor (ej. un PDF generado por el backend) y, por defecto, espera a
     * que quede disponible. Lee el contenido por partes: un stream o archivo grande no se carga
     * entero en memoria (como mucho una parte, 8 MB típicamente).
     *
     * Para files del usuario preferí `handleUpload()` + subida directa desde el navegador: así
     * los bytes no pasan por tu backend.
     *
     * @param string|resource|\SplFileInfo $data Bytes (string), un stream abierto, o la ruta de
     *        un archivo como `SplFileInfo`.
     * @param int|null   $size Obligatorio solo si `$data` es un stream sin tamaño conocido.
     * @param bool|float $wait Igual que en `complete()` (default: esperar hasta 30 s).
     * @param array<string, mixed> $metadata
     *
     * @throws FileServiceException
     */
    public function upload(
        string $name,
        string $mimeType,
        mixed $data,
        ?int $size = null,
        ?string $ownerRef = null,
        Visibility|string|null $visibility = null,
        array $metadata = [],
        bool|float $wait = true,
        ?string $actor = null,
    ): FileInfo {
        $ownStream = false;
        if ($data instanceof \SplFileInfo) {
            $path = $data->getPathname();
            $stream = @fopen($path, 'rb');
            if ($stream === false) {
                throw new \InvalidArgumentException("no se pudo abrir el archivo {$path}");
            }
            $data = $stream;
            $ownStream = true;
        }
        if (!is_string($data) && !is_resource($data)) {
            throw new \InvalidArgumentException('data debe ser string, stream o SplFileInfo');
        }

        try {
            $size ??= is_string($data) ? strlen($data) : self::streamSize($data);
            $created = $this->createUpload($name, $mimeType, $size, $ownerRef, $visibility, $metadata, $actor);
            $up = $created->upload;
            $parts = [];

            if (!$up->isMultipart()) {
                $this->put((string) $up->url, $data, $size, $up->headers);
            } else {
                $partSize = (int) $up->partSize;
                $partCount = (int) $up->partCount;
                $offset = 0;
                for ($first = 1; $first <= $partCount; $first += self::MAX_PARTS_PER_BATCH) {
                    $numbers = range($first, min($partCount, $first + self::MAX_PARTS_PER_BATCH - 1));
                    $urls = $this->signParts($created->id, $numbers, $actor);
                    foreach ($numbers as $n) {
                        $len = min($partSize, $size - $offset);
                        $chunk = is_string($data) ? substr($data, $offset, $len) : self::readExactly($data, $len);
                        if (!isset($urls[$n])) {
                            throw new FileServiceException(0, 'internal', "el File Service no firmó la parte {$n}");
                        }
                        $parts[] = ['partNumber' => $n, 'etag' => $this->put($urls[$n], $chunk, $len, [])];
                        $offset += $len;
                    }
                }
            }

            return $this->complete($created->id, $parts, $wait, $actor);
        } finally {
            if ($ownStream) {
                fclose($data);
            }
        }
    }

    // ─── Consulta ────────────────────────────────────────────────────────────

    /**
     * Metadatos del file y, si está disponible, una URL firmada de descarga de vida corta.
     *
     * @param bool $inline Pedir que el navegador lo muestre en vez de bajarlo (solo imágenes,
     *        video, audio y PDF; el resto siempre baja como adjunto).
     *
     * @throws FileServiceException
     */
    public function get(string $id, bool $inline = false, ?string $actor = null): FileInfo
    {
        $query = $inline ? '?disposition=inline' : '';

        return FileInfo::fromApi($this->request('GET', '/files/' . rawurlencode($id) . $query, null, $actor) ?? []);
    }

    /**
     * Atajo: la URL firmada de descarga. Lanza `invalid_state` si el file no está disponible.
     *
     * @throws FileServiceException
     */
    public function getDownloadUrl(string $id, bool $inline = false, ?string $actor = null): string
    {
        $file = $this->get($id, $inline, $actor);
        if ($file->download === null) {
            throw new FileServiceException(
                409,
                'invalid_state',
                "el archivo no está disponible para descarga (estado {$file->status->value})",
            );
        }

        return $file->download['url'];
    }

    /**
     * Espera a que el worker termine de verificar el file (consulta con intervalo creciente:
     * ×1.5 hasta 3 s). Lanza `FileRejectedException` si lo rechaza, y `timeout` si no termina a
     * tiempo (la verificación sigue en curso).
     *
     * @param float $timeout  Máximo de espera en segundos.
     * @param float $interval Intervalo inicial entre consultas en segundos.
     *
     * @throws FileServiceException
     */
    public function waitUntilAvailable(
        string $id,
        float $timeout = 30,
        float $interval = 0.5,
        ?string $actor = null,
    ): FileInfo {
        $file = $this->poll($id, $timeout, $interval, $actor);
        if ($file->status === FileStatus::Available) {
            return $file;
        }
        if ($file->status === FileStatus::Failed || $file->status === FileStatus::Quarantined) {
            throw new FileRejectedException($file);
        }

        throw new FileServiceException(
            0,
            'timeout',
            "el archivo sigue en {$file->status->value}: la verificación no terminó a tiempo"
            . ' (sigue en curso; consultá más tarde o usá el webhook)',
        );
    }

    /**
     * Lista los files del Proyecto, del más nuevo al más viejo. No incluye URLs de descarga.
     *
     * @param bool     $trashed `true` lista la papelera.
     * @param int|null $limit   Tamaño de página (default 50, máximo 200).
     *
     * @throws FileServiceException
     */
    public function list(
        ?string $ownerRef = null,
        FileStatus|string|null $status = null,
        bool $trashed = false,
        ?string $cursor = null,
        ?int $limit = null,
        ?string $actor = null,
    ): FilePage {
        $query = array_filter([
            'owner_ref' => $ownerRef,
            'status' => $status instanceof FileStatus ? $status->value : $status,
            'trashed' => $trashed ? 'true' : null,
            'cursor' => $cursor,
            'limit' => $limit,
        ], static fn (mixed $v): bool => $v !== null && $v !== '');
        $qs = http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        $raw = $this->request('GET', '/files' . ($qs !== '' ? "?{$qs}" : ''), null, $actor) ?? [];

        $files = array_map(
            static fn (array $f): FileInfo => FileInfo::fromApi($f),
            array_values((array) ($raw['files'] ?? [])),
        );
        $next = $raw['next_cursor'] ?? null;

        return new FilePage($files, is_string($next) && $next !== '' ? $next : null);
    }

    /**
     * Recorre todas las páginas de `list()`.
     *
     * @return \Generator<int, FileInfo>
     *
     * @throws FileServiceException
     */
    public function listAll(
        ?string $ownerRef = null,
        FileStatus|string|null $status = null,
        bool $trashed = false,
        ?int $limit = null,
        ?string $actor = null,
    ): \Generator {
        $cursor = null;
        do {
            $page = $this->list($ownerRef, $status, $trashed, $cursor, $limit, $actor);
            yield from $page->files;
            $cursor = $page->nextCursor;
        } while ($cursor !== null);
    }

    // ─── Cambios ─────────────────────────────────────────────────────────────

    /**
     * Cambia la visibilidad y/o el nombre. Hacer público o privado un file es instantáneo.
     *
     * @throws FileServiceException
     */
    public function update(
        string $id,
        Visibility|string|null $visibility = null,
        ?string $name = null,
        ?string $actor = null,
    ): FileInfo {
        $raw = $this->request('PATCH', '/files/' . rawurlencode($id), [
            'visibility' => $visibility instanceof Visibility ? $visibility->value : $visibility,
            'original_name' => $name,
        ], $actor);

        return FileInfo::fromApi($raw ?? []);
    }

    /**
     * Manda el file a la papelera. Se recupera con `restore()` durante la retención del Proyecto.
     *
     * @throws FileServiceException
     */
    public function delete(string $id, ?string $actor = null): void
    {
        $this->request('DELETE', '/files/' . rawurlencode($id), null, $actor);
    }

    /**
     * Recupera un file de la papelera.
     *
     * @throws FileServiceException
     */
    public function restore(string $id, ?string $actor = null): FileInfo
    {
        $raw = $this->request('POST', '/files/' . rawurlencode($id) . '/restore', null, $actor);

        return FileInfo::fromApi($raw ?? []);
    }

    // ─── Webhooks ────────────────────────────────────────────────────────────

    /**
     * Verifica la firma de un webhook y devuelve el evento.
     *
     * Pasá el body CRUDO (`file_get_contents('php://input')`, sin parsear) y el header
     * `FS-Signature`. Lanza si la firma falta o no coincide, o si el evento tiene más de
     * `$tolerance` segundos (protege contra reenvíos).
     *
     * @param int|null $now Segundos Unix actuales (solo para tests).
     *
     * @throws WebhookSignatureException
     */
    public static function verifyWebhook(
        string $payload,
        ?string $signature,
        string $secret,
        int $tolerance = 300,
        ?int $now = null,
    ): WebhookEvent {
        if ($signature === null || $signature === '') {
            throw new WebhookSignatureException('falta el header FS-Signature');
        }
        $fields = [];
        foreach (explode(',', $signature) as $kv) {
            $pair = explode('=', trim($kv), 2);
            if (count($pair) === 2) {
                $fields[$pair[0]] = $pair[1];
            }
        }
        $t = $fields['t'] ?? '';
        $v1 = strtolower($fields['v1'] ?? '');
        if (preg_match('/^[0-9]{1,19}$/D', $t) !== 1 || $v1 === '') {
            throw new WebhookSignatureException('FS-Signature con formato inválido');
        }

        $expected = hash_hmac('sha256', "{$t}.{$payload}", $secret);
        if (!hash_equals($expected, $v1)) {
            throw new WebhookSignatureException('la firma del webhook no coincide');
        }
        if (abs(($now ?? time()) - (int) $t) > $tolerance) {
            throw new WebhookSignatureException('el evento es demasiado viejo');
        }

        $raw = json_decode($payload, true);
        if (!is_array($raw) || !is_array($raw['data']['file'] ?? null)) {
            throw new WebhookSignatureException('payload del webhook inválido');
        }

        return new WebhookEvent(
            (string) ($raw['id'] ?? ''),
            (string) ($raw['type'] ?? ''),
            FileInfo::fromApi($raw['data']['file']),
        );
    }

    // ─── Endpoint de subida (protocolo del navegador) ────────────────────────

    /**
     * Implementa el endpoint de subida que usa `upload()` de `@ntropix/file-service/browser`
     * (protocolo en sdk/PROTOCOL.md): crear, firmar partes, completar y esperar la verificación.
     *
     * Tu backend autentica al usuario con su propio mecanismo y pasa su id como `$ownerRef`.
     * Nunca lanza: todo error vuelve como `UploadResult` con `{"error": {"code", "message"}}`.
     *
     *   $r = $fs->handleUpload(file_get_contents('php://input'), ownerRef: $userId);
     *   if ($r->isOk() && $r->file) guardarEnMiBase($r->file);   // complete exitoso
     *   $r->send();
     *
     * @param array<string, mixed>|string $body       JSON crudo o ya decodificado.
     * @param string                      $ownerRef   Id del usuario autenticado (vacío → 401).
     * @param Visibility|string|null      $visibility La fija el backend; el navegador no la elige.
     * @param array<string, mixed>        $metadata   Metadata del backend; se mezcla clave por clave
     *        sobre la del navegador (gana la del backend).
     * @param float                       $waitTimeout Espera máxima de la verificación en `complete`
     *        (segundos). Si vence, responde 200 con el file en `READY`.
     */
    public function handleUpload(
        array|string $body,
        string $ownerRef,
        Visibility|string|null $visibility = null,
        array $metadata = [],
        float $waitTimeout = 30,
    ): UploadResult {
        try {
            if ($ownerRef === '') {
                return UploadResult::error(401, 'unauthorized', 'falta el usuario autenticado (ownerRef)');
            }
            if (is_string($body)) {
                $body = json_decode($body, true);
            }
            if (!is_array($body) || ($body !== [] && array_is_list($body))) {
                return UploadResult::error(400, 'validation', 'body JSON inválido');
            }

            return match ($body['action'] ?? null) {
                'create' => $this->handleCreate($body, $ownerRef, $visibility, $metadata),
                'parts' => $this->handleParts($body, $ownerRef),
                'complete' => $this->handleComplete($body, $ownerRef, $waitTimeout),
                default => UploadResult::error(
                    400,
                    'validation',
                    'action desconocida: se espera create, parts o complete',
                ),
            };
        } catch (FileRejectedException $e) {
            // 422: el navegador recibe solo el error; el backend ve el file rechazado en `file`.
            return UploadResult::error(422, $e->errorCode, $e->getMessage(), $e->fileInfo);
        } catch (FileServiceException $e) {
            // Sin respuesta (red/timeout) → 502. Un 401/403 de la API significa que rechazó la key
            // del BACKEND: es un problema de configuración del servidor, nunca del usuario → 502.
            $status = ($e->status === 0 || $e->status === 401 || $e->status === 403) ? 502 : $e->status;

            return UploadResult::error($status, $e->errorCode, $e->getMessage());
        } catch (\Throwable) {
            return UploadResult::error(500, 'internal', 'error interno del endpoint de subida');
        }
    }

    /**
     * @param array<string, mixed> $b
     * @param array<string, mixed> $metadata
     */
    private function handleCreate(
        array $b,
        string $ownerRef,
        Visibility|string|null $visibility,
        array $metadata,
    ): UploadResult {
        $name = $b['name'] ?? null;
        $mimeType = $b['mimeType'] ?? null;
        $size = $b['size'] ?? null;
        if (is_float($size) && $size === floor($size)) {
            $size = (int) $size;
        }
        if (
            !is_string($name) || $name === '' || !is_string($mimeType) || $mimeType === ''
            || !is_int($size) || $size < 0
        ) {
            return UploadResult::error(400, 'validation', 'create requiere name, mimeType y size');
        }
        $clientMeta = $b['metadata'] ?? [];
        if (!is_array($clientMeta) || ($clientMeta !== [] && array_is_list($clientMeta))) {
            $clientMeta = [];
        }

        $created = $this->createUpload(
            $name,
            $mimeType,
            $size,
            ownerRef: $ownerRef,
            visibility: $visibility,
            metadata: $metadata + $clientMeta,
            actor: $ownerRef,
        );
        $token = UploadToken::sign($this->apiKey, $created->id, $ownerRef, ($this->clock)() + UploadToken::TTL);

        return new UploadResult(200, [
            'id' => $created->id,
            'token' => $token,
            'upload' => $created->upload->toArray(),
        ]);
    }

    /**
     * @param array<string, mixed> $b
     */
    private function handleParts(array $b, string $ownerRef): UploadResult
    {
        if (!$this->checkToken($b, $ownerRef)) {
            return UploadResult::error(403, 'forbidden', 'token de subida inválido o vencido');
        }
        $nums = $b['partNumbers'] ?? null;
        if (
            !is_array($nums) || !array_is_list($nums) || $nums === [] || count($nums) > self::MAX_PARTS_PER_BATCH
            || array_filter($nums, static fn (mixed $n): bool => !is_int($n) || $n < 1) !== []
        ) {
            return UploadResult::error(
                400,
                'validation',
                'partNumbers debe ser una lista de 1 a 100 enteros positivos',
            );
        }

        $urls = [];
        foreach ($this->signParts($b['id'], $nums, $ownerRef) as $n => $url) {
            $urls[] = ['partNumber' => $n, 'url' => $url];
        }

        return new UploadResult(200, ['urls' => $urls]);
    }

    /**
     * @param array<string, mixed> $b
     */
    private function handleComplete(array $b, string $ownerRef, float $waitTimeout): UploadResult
    {
        if (!$this->checkToken($b, $ownerRef)) {
            return UploadResult::error(403, 'forbidden', 'token de subida inválido o vencido');
        }
        $parts = [];
        $rawParts = $b['parts'] ?? [];
        if (!is_array($rawParts) || !array_is_list($rawParts)) {
            return UploadResult::error(400, 'validation', 'parts debe ser una lista de {partNumber, etag}');
        }
        foreach ($rawParts as $p) {
            if (!is_array($p) || !is_int($p['partNumber'] ?? null) || !is_string($p['etag'] ?? null)) {
                return UploadResult::error(400, 'validation', 'parts debe ser una lista de {partNumber, etag}');
            }
            $parts[] = ['partNumber' => $p['partNumber'], 'etag' => $p['etag']];
        }

        $id = $b['id'];
        $file = $this->complete($id, $parts, actor: $ownerRef);
        if ($waitTimeout > 0 && !$file->status->isFinal()) {
            // Si la espera vence se devuelve el file como está (READY): la verificación sigue.
            $file = $this->poll($id, $waitTimeout, 0.5, $ownerRef);
        }
        if ($file->status === FileStatus::Failed || $file->status === FileStatus::Quarantined) {
            throw new FileRejectedException($file);
        }

        return new UploadResult(200, $file->toArray(), $file);
    }

    /**
     * @param array<string, mixed> $b
     */
    private function checkToken(array $b, string $ownerRef): bool
    {
        $id = $b['id'] ?? null;
        $token = $b['token'] ?? null;

        return is_string($id) && $id !== '' && is_string($token)
            && UploadToken::verify($this->apiKey, $token, $id, $ownerRef, ($this->clock)());
    }

    // ─── Internos ────────────────────────────────────────────────────────────

    /**
     * Consulta el file hasta que la verificación termine o venza `$timeout`; devuelve el último
     * estado visto (que puede no ser final).
     */
    private function poll(string $id, float $timeout, float $interval, ?string $actor): FileInfo
    {
        $deadline = microtime(true) + $timeout;
        for (;;) {
            $file = $this->get($id, actor: $actor);
            if ($file->status->isFinal() || microtime(true) + $interval > $deadline) {
                return $file;
            }
            usleep((int) ($interval * 1_000_000));
            $interval = min($interval * 1.5, 3.0);
        }
    }

    /**
     * Request a la API con reintentos (solo si `$idempotent`) ante red, 429 y 5xx.
     *
     * @param array<string, mixed>|null $body Los valores `null` se omiten del JSON.
     * @return array<string, mixed>|null
     *
     * @throws FileServiceException
     */
    private function request(
        string $method,
        string $path,
        ?array $body,
        ?string $actor,
        bool $idempotent = true,
    ): ?array {
        $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json'];
        if ($actor !== null && $actor !== '') {
            $headers[] = 'FS-Actor: ' . str_replace(["\r", "\n"], '', $actor);
        }
        $payload = null;
        if ($body !== null) {
            $body = array_filter($body, static fn (mixed $v): bool => $v !== null);
            $payload = json_encode(
                $body === [] ? new \stdClass() : $body,
                JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
            );
            $headers[] = 'Content-Type: application/json';
        }

        // Solo se reintenta lo que es seguro repetir: crear un file dos veces dejaría uno huérfano.
        $attempts = $idempotent ? $this->retries + 1 : 1;
        for ($attempt = 1;; $attempt++) {
            $delay = 0.25 * 2 ** ($attempt - 1);
            try {
                $res = $this->send($method, $this->baseUrl . $path, $headers, $payload);
            } catch (FileServiceException $e) {
                if ($attempt >= $attempts) {
                    throw $e;
                }
                usleep((int) ($delay * 1_000_000));
                continue;
            }

            $status = $res['status'];
            if ($status === 204) {
                return null;
            }
            $json = $res['body'] === '' ? null : json_decode($res['body'], true);
            if ($status >= 200 && $status < 300) {
                return is_array($json) ? $json : null;
            }

            $err = is_array($json) && is_array($json['error'] ?? null) ? $json['error'] : [];
            $e = new FileServiceException(
                $status,
                is_string($err['code'] ?? null) ? $err['code'] : 'internal',
                is_string($err['message'] ?? null)
                    ? $err['message']
                    : "respuesta inesperada del File Service (HTTP {$status})",
                requestId: ($res['headers']['x-request-id'] ?? '') !== '' ? $res['headers']['x-request-id'] : null,
            );
            if (($status !== 429 && $status < 500) || $attempt >= $attempts) {
                throw $e;
            }
            $retryAfter = self::parseRetryAfter($res['headers']['retry-after'] ?? null);
            usleep((int) (($retryAfter ?? $delay) * 1_000_000));
        }
    }

    /**
     * PUT de bytes a una URL firmada del storage. Devuelve el ETag sin comillas.
     * Reintenta ante red/5xx si el contenido se puede repetir (string o stream con seek).
     *
     * @param string|resource       $body
     * @param array<string, string> $headers
     *
     * @throws FileServiceException
     */
    private function put(string $url, mixed $body, int $length, array $headers): string
    {
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "{$k}: {$v}";
        }
        if (!array_key_exists('content-type', array_change_key_case($headers))) {
            $lines[] = 'Content-Type:'; // evita el Content-Type de formulario que curl agrega por defecto
        }
        $start = is_resource($body) ? ftell($body) : 0;
        $rewindable = is_string($body) || ($start !== false && (stream_get_meta_data($body)['seekable'] ?? false));
        $attempts = $rewindable ? $this->retries + 1 : 1;

        for ($attempt = 1;; $attempt++) {
            if ($attempt > 1 && is_resource($body)) {
                fseek($body, (int) $start);
            }
            try {
                $res = $this->send('PUT', $url, $lines, $body, $length, storage: true);
            } catch (FileServiceException $e) {
                if ($attempt >= $attempts) {
                    $msg = 'no se pudo subir al storage: ' . $e->getMessage();
                    throw new FileServiceException(0, $e->errorCode, $msg, $e);
                }
                usleep((int) (0.25 * 2 ** ($attempt - 1) * 1_000_000));
                continue;
            }
            if ($res['status'] >= 200 && $res['status'] < 300) {
                return trim($res['headers']['etag'] ?? '', '"');
            }
            if ($res['status'] < 500 || $attempt >= $attempts) {
                throw new FileServiceException(
                    $res['status'],
                    'storage_rejected',
                    "el storage rechazó la subida (HTTP {$res['status']})",
                );
            }
            usleep((int) (0.25 * 2 ** ($attempt - 1) * 1_000_000));
        }
    }

    /**
     * Ejecuta un request HTTP con curl.
     *
     * @param list<string>         $headers
     * @param string|resource|null $body
     * @return array{status: int, headers: array<string, string>, body: string}
     *
     * @throws FileServiceException `network` o `timeout` si no hubo respuesta.
     */
    private function send(
        string $method,
        string $url,
        array $headers,
        mixed $body,
        ?int $length = null,
        bool $storage = false,
    ): array {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new FileServiceException(0, 'network', 'no se pudo inicializar curl');
        }
        $respHeaders = [];
        $timeoutMs = max(1, (int) round($this->timeout * 1000));
        $opts = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT_MS => min($timeoutMs, 10_000),
            CURLOPT_HTTPHEADER => [...$headers, 'Expect:'],
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$respHeaders): int {
                if (str_starts_with($line, 'HTTP/')) {
                    $respHeaders = []; // nueva respuesta (ej. después de un 100 Continue)
                } elseif (($p = strpos($line, ':')) !== false) {
                    $respHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
                }

                return strlen($line);
            },
        ];
        if ($storage) {
            // Una subida grande puede tardar más que el timeout: se corta solo si se estanca.
            $opts[CURLOPT_LOW_SPEED_LIMIT] = 1;
            $opts[CURLOPT_LOW_SPEED_TIME] = max(1, (int) ceil($this->timeout));
        } else {
            $opts[CURLOPT_TIMEOUT_MS] = $timeoutMs;
        }

        if (is_resource($body)) {
            $remaining = (int) $length;
            $opts[CURLOPT_UPLOAD] = true;
            $opts[CURLOPT_INFILESIZE] = $remaining;
            $opts[CURLOPT_READFUNCTION] = static function ($ch, $fd, int $max) use ($body, &$remaining): string {
                if ($remaining <= 0) {
                    return '';
                }
                $chunk = fread($body, min($max, $remaining));
                $chunk = $chunk === false ? '' : $chunk;
                $remaining -= strlen($chunk);

                return $chunk;
            };
        } elseif (is_string($body)) {
            $opts[CURLOPT_POSTFIELDS] = $body;
        } elseif ($method !== 'GET' && $method !== 'HEAD') {
            // Sin body: Content-Length 0 y sin el Content-Type de formulario que curl pone por defecto.
            $opts[CURLOPT_POSTFIELDS] = '';
            $opts[CURLOPT_HTTPHEADER][] = 'Content-Type:';
        }
        curl_setopt_array($ch, $opts);

        $resBody = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($resBody === false || $errno !== 0) {
            if ($errno === CURLE_OPERATION_TIMEDOUT) {
                throw new FileServiceException(0, 'timeout', "el File Service no respondió en {$this->timeout} s");
            }
            throw new FileServiceException(0, 'network', "no se pudo conectar con el File Service: {$error}");
        }

        return ['status' => $status, 'headers' => $respHeaders, 'body' => (string) $resBody];
    }

    /** Segundos a esperar según `Retry-After` (segundos o fecha HTTP), con tope. */
    private static function parseRetryAfter(?string $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_numeric($value)) {
            $secs = (float) $value;
        } else {
            $ts = strtotime($value);
            if ($ts === false) {
                return null;
            }
            $secs = (float) ($ts - time());
        }

        return $secs > 0 ? min($secs, self::MAX_RETRY_AFTER) : null;
    }

    /**
     * Tamaño de un stream sobre un archivo regular.
     *
     * @param resource $stream
     */
    private static function streamSize(mixed $stream): int
    {
        $stat = fstat($stream);
        $pos = ftell($stream);
        if ($stat === false || $pos === false || ($stat['mode'] & 0170000) !== 0100000) {
            throw new \InvalidArgumentException('no se puede saber el tamaño del stream: pasá size');
        }

        return max(0, $stat['size'] - $pos);
    }

    /**
     * Lee exactamente `$len` bytes de un stream (o falla si termina antes).
     *
     * @param resource $stream
     */
    private static function readExactly(mixed $stream, int $len): string
    {
        $buf = '';
        while (strlen($buf) < $len) {
            $chunk = fread($stream, $len - strlen($buf));
            if ($chunk === false || $chunk === '') {
                throw new \InvalidArgumentException('el stream terminó antes del tamaño declarado');
            }
            $buf .= $chunk;
        }

        return $buf;
    }
}
