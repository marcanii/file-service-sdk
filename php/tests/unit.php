<?php

// Tests unitarios (sin red real: levanta un `php -S` local con tests/fake_api.php).
//   docker run --rm -v "$PWD/sdk":/sdk -w /sdk/php php:8.3-cli php tests/unit.php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Ntropix\FileService\FileRejectedException;
use Ntropix\FileService\FileService;
use Ntropix\FileService\FileServiceException;
use Ntropix\FileService\FileStatus;
use Ntropix\FileService\UploadResult;
use Ntropix\FileService\UploadToken;
use Ntropix\FileService\Visibility;
use Ntropix\FileService\WebhookSignatureException;

$vectors = json_decode((string) file_get_contents(__DIR__ . '/../../testdata/vectors.json'), true, flags: JSON_THROW_ON_ERROR);

// ─── Servidor fake ───────────────────────────────────────────────────────────

$state = sys_get_temp_dir() . '/fs-fake-' . getmypid();
@mkdir($state);
$port = 18000 + getmypid() % 1000;
$server = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__ . '/fake_api.php'],
    [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    null,
    ['FAKE_STATE' => $state],
);
register_shutdown_function(static function () use ($server, $state): void {
    proc_terminate($server);
    array_map('unlink', glob("{$state}/*") ?: []);
    @rmdir($state);
});
for ($i = 0; $i < 50 && @fsockopen('127.0.0.1', $port) === false; $i++) {
    usleep(100_000);
}
$base = "http://127.0.0.1:{$port}";

/** @return list<array<string, mixed>> */
function apiLog(string $state): array
{
    $lines = @file("{$state}/log.jsonl", FILE_IGNORE_NEW_LINES) ?: [];
    @unlink("{$state}/log.jsonl");

    return array_map(static fn (string $l): array => json_decode($l, true), $lines);
}

$now = 1_731_000_000;
$clock = static function () use (&$now): int {
    return $now;
};
$key = 'fsk_test_unit';
$fs = new FileService($key, $base, timeout: 5, retries: 2, clock: $clock);

// ─── Webhooks ────────────────────────────────────────────────────────────────

echo "webhooks\n";
$w = $vectors['webhook'];

T::test('vector válido → evento', function () use ($w): void {
    $ev = FileService::verifyWebhook($w['payload'], $w['signature'], $w['secret'], now: $w['timestamp']);
    T::eq($w['expected']['id'], $ev->id);
    T::eq($w['expected']['type'], $ev->type);
    T::eq($w['expected']['fileId'], $ev->file->id);
    T::eq($w['expected']['fileName'], $ev->file->name);
    T::eq($w['expected']['mimeType'], $ev->file->mimeType);
    T::eq($w['expected']['size'], $ev->file->size);
    T::eq(FileStatus::Available, $ev->file->status);
});

T::test('payload alterado → WebhookSignatureException', function () use ($w): void {
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook(
        str_replace('1234', '1235', $w['payload']),
        $w['signature'],
        $w['secret'],
        now: $w['timestamp'],
    ));
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook($w['payload'], $w['signature'], 'otro', now: $w['timestamp']));
});

T::test('evento viejo (> 300 s) → WebhookSignatureException; justo 300 s pasa', function () use ($w): void {
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook(
        $w['payload'],
        $w['signature'],
        $w['secret'],
        now: $w['timestamp'] + 301,
    ));
    FileService::verifyWebhook($w['payload'], $w['signature'], $w['secret'], now: $w['timestamp'] + 300);
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook($w['payload'], $w['signature'], $w['secret']));
});

T::test('sin firma o con formato inválido → WebhookSignatureException', function () use ($w): void {
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook($w['payload'], null, $w['secret']));
    T::throws(WebhookSignatureException::class, fn () => FileService::verifyWebhook($w['payload'], 'v1=abc', $w['secret']));
});

// ─── Token de subida ─────────────────────────────────────────────────────────

echo "token de subida\n";
$tv = $vectors['uploadToken'];

T::test('sign reproduce los vectores', function () use ($tv): void {
    foreach ($tv['cases'] as $c) {
        T::eq($c['token'], UploadToken::sign($tv['apiKey'], $c['id'], $c['ownerRef'], $c['exp']));
    }
});

T::test('verify: válido antes de exp; vencido, otro owner, otro id o alterado → false', function () use ($tv): void {
    foreach ($tv['cases'] as $c) {
        T::true(UploadToken::verify($tv['apiKey'], $c['token'], $c['id'], $c['ownerRef'], $c['exp'] - 1), 'válido');
        T::true(!UploadToken::verify($tv['apiKey'], $c['token'], $c['id'], $c['ownerRef'], $c['exp']), 'exp == now');
        T::true(!UploadToken::verify($tv['apiKey'], $c['token'], $c['id'], $c['ownerRef'], $c['exp'] + 1), 'vencido');
        T::true(!UploadToken::verify($tv['apiKey'], $c['token'], $c['id'], 'intruso', $c['exp'] - 1), 'otro owner');
        T::true(!UploadToken::verify($tv['apiKey'], $c['token'], $c['id'] . 'x', $c['ownerRef'], $c['exp'] - 1), 'otro id');
        T::true(!UploadToken::verify('otra_key', $c['token'], $c['id'], $c['ownerRef'], $c['exp'] - 1), 'otra key');
        T::true(!UploadToken::verify($tv['apiKey'], ($c['exp'] + 1) . substr($c['token'], strlen((string) $c['exp'])), $c['id'], $c['ownerRef'], 0), 'exp alterado');
    }
});

T::test('handleUpload con el reloj inyectado: otro owner → 403, vencido → 403', function () use ($tv, $base, $state): void {
    $c = $tv['cases'][0];
    $t = $c['exp'] - 10;
    $fs = new FileService($tv['apiKey'], $base, clock: static fn (): int => $t);
    $body = ['action' => 'complete', 'id' => $c['id'], 'token' => $c['token']];
    $r = $fs->handleUpload($body, 'intruso');
    T::eq(403, $r->status);
    T::eq('forbidden', $r->body['error']['code']);
    $late = new FileService($tv['apiKey'], $base, clock: static fn (): int => $c['exp']);
    T::eq(403, $late->handleUpload($body, $c['ownerRef'])->status);
    T::eq(403, $late->handleUpload(['action' => 'parts', 'id' => $c['id'], 'token' => $c['token'], 'partNumbers' => [1]], $c['ownerRef'])->status);
    T::eq([], apiLog($state), 'no debe llamar a la API con un token inválido');
});

// ─── handleUpload ────────────────────────────────────────────────────────────

echo "handleUpload\n";

T::test('action desconocida, body inválido y sin usuario', function () use ($fs, $state): void {
    $r = $fs->handleUpload(['action' => 'borrar'], 'user_1');
    T::eq(400, $r->status);
    T::eq('validation', $r->body['error']['code']);
    T::eq(400, $fs->handleUpload('{no es json', 'user_1')->status);
    T::eq(400, $fs->handleUpload('[1,2]', 'user_1')->status);
    T::eq(400, $fs->handleUpload(['action' => 'create', 'name' => 'a.txt', 'mimeType' => 'text/plain'], 'user_1')->status);
    T::eq(401, $fs->handleUpload(['action' => 'create'], '')->status);
    T::eq([], apiLog($state));
});

T::test('create ok: token válido para ese owner, upload en camelCase, metadata del backend pisa', function () use ($fs, $key, $state, &$now): void {
    $r = $fs->handleUpload(
        '{"action":"create","name":"foto.jpg","mimeType":"image/jpeg","size":10,"metadata":{"album":"x","origen":"cliente"}}',
        'user_1',
        visibility: Visibility::Public,
        metadata: ['origen' => 'backend'],
    );
    T::eq(200, $r->status, json_encode($r->body));
    T::eq('f-simple', $r->body['id']);
    T::true(UploadToken::verify($key, $r->body['token'], 'f-simple', 'user_1', $now), 'token válido');
    T::eq((string) ($now + 86400), explode('.', $r->body['token'])[0], 'exp = now + 24 h');
    $json = json_decode($r->json(), true);
    T::eq('simple', $json['upload']['mode']);
    T::eq(['Content-Type' => 'image/jpeg'], $json['upload']['headers']);
    T::true(isset($json['upload']['url'], $json['upload']['expiresAt']));

    $req = apiLog($state)[0];
    T::eq('POST /files', $req['method'] . ' ' . $req['path']);
    T::eq('Bearer ' . $key, $req['auth']);
    T::eq('user_1', $req['actor']);
    T::eq('user_1', $req['body']['owner_ref']);
    T::eq('public', $req['body']['visibility']);
    T::eq(['origen' => 'backend', 'album' => 'x'], $req['body']['metadata']);
});

T::test('create multipart → partes firmadas por el endpoint (parts)', function () use ($fs, $state): void {
    $r = $fs->handleUpload(['action' => 'create', 'name' => 'g.bin', 'mimeType' => 'application/octet-stream', 'size' => 250], 'user_1');
    T::eq(['mode' => 'multipart', 'partSize' => 100, 'partCount' => 3], array_diff_key($r->body['upload'], ['expiresAt' => 1]));
    $p = $fs->handleUpload(['action' => 'parts', 'id' => $r->body['id'], 'token' => $r->body['token'], 'partNumbers' => [1, 2, 3]], 'user_1');
    T::eq(200, $p->status, json_encode($p->body));
    T::eq([1, 2, 3], array_column($p->body['urls'], 'partNumber'));
    T::eq(400, $fs->handleUpload(['action' => 'parts', 'id' => $r->body['id'], 'token' => $r->body['token'], 'partNumbers' => range(1, 101)], 'user_1')->status);
    T::eq(400, $fs->handleUpload(['action' => 'parts', 'id' => $r->body['id'], 'token' => $r->body['token'], 'partNumbers' => [0]], 'user_1')->status);
    $log = apiLog($state);
    T::eq([1, 2, 3], $log[1]['body']['part_numbers']);
});

T::test('errores de la API se propagan tal cual (413 too_large) y create no se reintenta', function () use ($fs, $state): void {
    $r = $fs->handleUpload(['action' => 'create', 'name' => 'big.bin', 'mimeType' => 'application/octet-stream', 'size' => 5_000_000], 'user_1');
    T::eq(413, $r->status);
    T::eq('too_large', $r->body['error']['code']);
    apiLog($state);
    $r = $fs->handleUpload(['action' => 'create', 'name' => 'caido.txt', 'mimeType' => 'text/plain', 'size' => 1], 'user_1');
    T::eq(503, $r->status);
    T::eq(1, count(apiLog($state)), 'create es un único intento');
});

$token = static fn (string $id, string $owner = 'user_1'): string => UploadToken::sign($key, $id, $owner, $now + 3600);

T::test('complete ok → 200 con FileInfo AVAILABLE (camelCase), partes con ETag sin comillas', function () use ($fs, $token, $state): void {
    $r = $fs->handleUpload([
        'action' => 'complete', 'id' => 'f-1', 'token' => $token('f-1'),
        'parts' => [['partNumber' => 1, 'etag' => '"abc"']],
    ], 'user_1');
    T::eq(200, $r->status, json_encode($r->body));
    T::true($r->file !== null && $r->file->status === FileStatus::Available);
    T::eq('AVAILABLE', $r->body['status']);
    T::eq('image/jpeg', $r->body['mimeType']);
    T::true(str_contains($r->json(), '"metadata":{}'), 'metadata vacía como {}');
    T::eq(['url' => 'http://storage/x', 'expiresAt' => '2026-11-10T12:05:00Z'], $r->body['download']);
    $log = apiLog($state);
    T::eq([['part_number' => 1, 'etag' => 'abc']], $log[0]['body']['parts']);
});

T::test('retry ante 503 en complete (idempotente)', function () use ($fs, $token, $state): void {
    $r = $fs->handleUpload(['action' => 'complete', 'id' => 'flaky', 'token' => $token('flaky')], 'user_1');
    T::eq(200, $r->status, json_encode($r->body));
    $completes = array_filter(apiLog($state), static fn (array $l): bool => $l['path'] === '/files/flaky/complete');
    T::eq(2, count($completes));
});

T::test('API devuelve 401/403 (key del backend rechazada) → 502 conservando el code', function () use ($base): void {
    $create = ['action' => 'create', 'name' => 'a.txt', 'mimeType' => 'text/plain', 'size' => 1];
    $r = (new FileService('fsk_test_revocada', $base))->handleUpload($create, 'user_1');
    T::eq(502, $r->status);
    T::eq('unauthorized', $r->body['error']['code']);
    $r = (new FileService('fsk_test_desactivada', $base))->handleUpload($create, 'user_1');
    T::eq(502, $r->status);
    T::eq('project_disabled', $r->body['error']['code']);
});

T::test('error inesperado → 500 internal (nunca lanza)', function () use ($fs): void {
    $r = $fs->handleUpload(['action' => 'create', 'name' => 'a.txt', 'mimeType' => 'text/plain', 'size' => 1], 'user_1', metadata: ['x' => NAN]);
    T::eq(500, $r->status);
    T::eq('internal', $r->body['error']['code']);
});

T::test('rechazo → 422 quarantined (file solo para el backend); espera vencida → 200 READY', function () use ($fs, $token): void {
    $r = $fs->handleUpload(['action' => 'complete', 'id' => 'quar', 'token' => $token('quar')], 'user_1');
    T::eq(422, $r->status);
    T::eq('quarantined', $r->body['error']['code']);
    T::eq(['error'], array_keys($r->body));
    T::eq(FileStatus::Quarantined, $r->file?->status);
    $t0 = microtime(true);
    $r = $fs->handleUpload(['action' => 'complete', 'id' => 'slow', 'token' => $token('slow')], 'user_1', waitTimeout: 1);
    T::eq(200, $r->status);
    T::eq('READY', $r->body['status']);
    T::true(microtime(true) - $t0 < 3, 'respeta waitTimeout');
});

T::test('sin conexión con el File Service → 502 network', function () use ($key, $token): void {
    $down = new FileService($key, 'http://127.0.0.1:1', timeout: 2, retries: 0);
    $r = $down->handleUpload(['action' => 'create', 'name' => 'a.txt', 'mimeType' => 'text/plain', 'size' => 1], 'user_1');
    T::eq(502, $r->status);
    T::eq('network', $r->body['error']['code']);
});

T::test('UploadResult::send emite el JSON', function (): void {
    $r = UploadResult::error(400, 'validation', 'x');
    ob_start();
    $r->send();
    T::eq('{"error":{"code":"validation","message":"x"}}', ob_get_clean());
});

// ─── Cliente ─────────────────────────────────────────────────────────────────

echo "cliente\n";

T::test('429 con Retry-After se reintenta', function () use ($fs, $state): void {
    apiLog($state);
    $t0 = microtime(true);
    T::eq('ratelimited', $fs->get('ratelimited')->id);
    T::true(microtime(true) - $t0 >= 0.9, 'respeta Retry-After: 1');
    T::eq(2, count(apiLog($state)));
});

T::test('errores tipados y FileRejectedException en wait', function () use ($fs): void {
    T::throws(FileServiceException::class, fn () => $fs->get('missing'), function (FileServiceException $e): void {
        T::eq(404, $e->status);
        T::eq('not_found', $e->errorCode);
    });
    T::throws(FileRejectedException::class, fn () => $fs->complete('quar', wait: 2), function (FileRejectedException $e): void {
        T::eq('quarantined', $e->errorCode);
        T::eq(FileStatus::Quarantined, $e->fileInfo->status);
    });
    T::throws(FileServiceException::class, fn () => $fs->waitUntilAvailable('slow', timeout: 0.6), function (FileServiceException $e): void {
        T::eq('timeout', $e->errorCode);
    });
});

T::test('get(inline), list/listAll, update, delete, restore, FS-Actor', function () use ($fs, $state): void {
    apiLog($state);
    T::eq('http://storage/x', $fs->getDownloadUrl('x', inline: true, actor: 'u9'));
    $page = $fs->list(ownerRef: 'user 1', status: FileStatus::Available, trashed: true, limit: 2);
    T::eq(['a', 'b'], array_map(static fn ($f) => $f->id, $page->files));
    T::eq('b', $page->nextCursor);
    T::eq(['a', 'b', 'c'], array_map(static fn ($f) => $f->id, iterator_to_array($fs->listAll(), false)));
    T::eq(Visibility::Public, $fs->update('x', visibility: 'public', actor: 'u9')->visibility);
    $fs->delete('x');
    T::eq('x', $fs->restore('x')->id);
    $log = apiLog($state);
    T::eq('disposition=inline', $log[0]['query']);
    T::eq('u9', $log[0]['actor']);
    T::eq('owner_ref=user%201&status=AVAILABLE&trashed=true&limit=2', $log[1]['query']);
    T::eq('cursor=b', $log[3]['query']);
    T::eq(['visibility' => 'public'], $log[4]['body']);
    T::eq('DELETE', $log[5]['method']);
    T::eq('POST /files/x/restore', $log[6]['method'] . ' ' . $log[6]['path']);
});

T::test('upload() server-side: simple desde string y multipart desde stream', function () use ($fs, $state): void {
    apiLog($state);
    T::eq(FileStatus::Available, $fs->upload('a.txt', 'text/plain', 'hola')->status);
    $log = apiLog($state);
    T::eq('PUT /storage/f-simple', $log[1]['method'] . ' ' . $log[1]['path']);
    T::eq(4, $log[1]['length']);
    T::eq('text/plain', $log[1]['contentType']);

    $tmp = tmpfile();
    fwrite($tmp, str_repeat('x', 250));
    rewind($tmp);
    $fs->upload('g.bin', 'application/octet-stream', $tmp, wait: false);
    $log = apiLog($state);
    $puts = array_values(array_filter($log, static fn (array $l): bool => $l['method'] === 'PUT'));
    T::eq([100, 100, 50], array_column($puts, 'length'));
    $complete = end($log);
    T::eq([['part_number' => 1, 'etag' => 'etag-100'], ['part_number' => 2, 'etag' => 'etag-100'], ['part_number' => 3, 'etag' => 'etag-50']], $complete['body']['parts']);

    $path = tempnam(sys_get_temp_dir(), 'fs');
    file_put_contents($path, 'desde archivo');
    $fs->upload('c.txt', 'text/plain', new SplFileInfo($path), wait: false);
    unlink($path);
    T::eq(13, apiLog($state)[1]['length']);
});

T::finish();
