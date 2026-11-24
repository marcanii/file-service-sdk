<?php

// Router para `php -S`: imita la API del File Service y el storage para los tests unitarios.
// Registra cada request en $FAKE_STATE/log.jsonl.

declare(strict_types=1);

$state = (string) getenv('FAKE_STATE');
$method = $_SERVER['REQUEST_METHOD'];
$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$raw = (string) file_get_contents('php://input');
$body = json_decode($raw, true);
$self = 'http://' . $_SERVER['HTTP_HOST'];

file_put_contents("{$state}/log.jsonl", json_encode([
    'method' => $method,
    'path' => $path,
    'query' => $_SERVER['QUERY_STRING'] ?? '',
    'auth' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    'actor' => $_SERVER['HTTP_FS_ACTOR'] ?? null,
    'contentType' => $_SERVER['CONTENT_TYPE'] ?? null,
    'length' => strlen($raw),
    'body' => $body,
]) . "\n", FILE_APPEND | LOCK_EX);

/** Cuenta cuántas veces se pidió algo (para simular fallas transitorias). */
function hit(string $state, string $key): int
{
    $f = "{$state}/hit-" . md5($key);
    $n = (int) @file_get_contents($f) + 1;
    file_put_contents($f, (string) $n);

    return $n;
}

function reply(int $status, mixed $json = null, array $headers = []): void
{
    http_response_code($status);
    foreach ($headers as $h) {
        header($h);
    }
    if ($json !== null) {
        header('Content-Type: application/json');
        echo json_encode($json);
    }
}

function fail(int $status, string $code, array $headers = []): void
{
    reply($status, ['error' => ['code' => $code, 'message' => "falla simulada {$code}"]], $headers);
}

function file_json(string $id, string $status, bool $download = false): array
{
    $f = [
        'id' => $id, 'project' => 'demo', 'status' => $status, 'original_name' => 'foto.jpg',
        'mime_type' => 'image/jpeg', 'size_bytes' => 10, 'owner_ref' => 'user_1', 'visibility' => 'private',
        'metadata' => (object) [], 'created_at' => '2026-11-10T12:00:00Z',
    ];
    if ($download && $status === 'AVAILABLE') {
        $f['download'] = ['url' => 'http://storage/x', 'expires_at' => '2026-11-10T12:05:00Z'];
    }

    return $f;
}

if (str_starts_with($path, '/storage/')) {
    if ($method === 'PUT') {
        reply(200, null, ['ETag: "etag-' . strlen($raw) . '"']);
    } else {
        reply(405);
    }
    return true;
}

if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') === 'Bearer fsk_test_revocada') {
    fail(401, 'unauthorized');
    return true;
}
if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') === 'Bearer fsk_test_desactivada') {
    fail(403, 'project_disabled');
    return true;
}

if ($method === 'POST' && $path === '/files') {
    if (($body['original_name'] ?? '') === 'caido.txt') {
        fail(503, 'internal');
    } elseif (($body['size_bytes'] ?? 0) > 1_000_000) {
        fail(413, 'too_large');
    } elseif (($body['size_bytes'] ?? 0) > 100) {
        reply(201, ['id' => 'f-multi', 'status' => 'PENDING', 'upload' => [
            'mode' => 'multipart', 'part_size' => 100, 'part_count' => (int) ceil($body['size_bytes'] / 100),
            'expires_at' => '2026-11-11T12:00:00Z',
        ]]);
    } else {
        reply(201, ['id' => 'f-simple', 'status' => 'PENDING', 'upload' => [
            'mode' => 'simple', 'url' => "{$self}/storage/f-simple",
            'headers' => ['Content-Type' => $body['mime_type'] ?? ''], 'expires_at' => '2026-11-11T12:00:00Z',
        ]]);
    }
    return true;
}

if ($method === 'GET' && $path === '/files') {
    $cursor = $_GET['cursor'] ?? '';
    if ($cursor === '') {
        reply(200, ['files' => [file_json('a', 'AVAILABLE'), file_json('b', 'READY')], 'next_cursor' => 'b']);
    } else {
        reply(200, ['files' => [file_json('c', 'AVAILABLE')]]);
    }
    return true;
}

if (preg_match('#^/files/([^/]+)(/[a-z]+)?$#', $path, $m) === 1) {
    $id = $m[1];
    $sub = $m[2] ?? '';
    if ($method === 'POST' && $sub === '/parts') {
        $urls = array_map(fn (int $n) => ['part_number' => $n, 'url' => "{$self}/storage/{$id}/{$n}"], $body['part_numbers']);
        reply(200, ['urls' => $urls, 'expires_at' => '2026-11-11T12:00:00Z']);
    } elseif ($method === 'POST' && $sub === '/complete') {
        if ($id === 'flaky' && hit($state, "complete-{$id}") === 1) {
            fail(503, 'internal');
        } else {
            reply(200, file_json($id, 'READY'));
        }
    } elseif ($method === 'GET' && $sub === '') {
        if ($id === 'ratelimited' && hit($state, "get-{$id}") === 1) {
            fail(429, 'rate_limited', ['Retry-After: 1']);
        } elseif ($id === 'missing') {
            fail(404, 'not_found', ['X-Request-ID: req-123']);
        } elseif ($id === 'quar') {
            reply(200, file_json($id, 'QUARANTINED'));
        } elseif ($id === 'slow') {
            reply(200, file_json($id, 'READY'));
        } else {
            reply(200, file_json($id, 'AVAILABLE', true));
        }
    } elseif ($method === 'PATCH' && $sub === '') {
        reply(200, array_merge(file_json($id, 'AVAILABLE'), ['visibility' => $body['visibility'] ?? 'private']));
    } elseif ($method === 'DELETE' && $sub === '') {
        reply(204);
    } elseif ($method === 'POST' && $sub === '/restore') {
        reply(200, file_json($id, 'AVAILABLE'));
    } else {
        fail(404, 'not_found');
    }
    return true;
}

fail(404, 'not_found');
return true;
