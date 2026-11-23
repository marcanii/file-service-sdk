<?php

// Prueba del SDK contra un File Service real.
//   docker run --rm --network host -e FS_KEY=fsk_test_... [-e FS_URL=http://localhost:8080] \
//     -v "$PWD/sdk":/sdk -w /sdk/php php:8.3-cli php tests/e2e.php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Ntropix\FileService\FileService;
use Ntropix\FileService\FileServiceException;
use Ntropix\FileService\FileStatus;
use Ntropix\FileService\Visibility;

$key = (string) getenv('FS_KEY');
if ($key === '') {
    fwrite(STDERR, "falta FS_KEY\n");
    exit(2);
}
$baseUrl = getenv('FS_URL') ?: 'http://localhost:8080';
$fs = new FileService($key, $baseUrl);

/** HTTP simple para hacer de "navegador" y del storage. @return array{int, string, array<string,string>} */
function http(string $method, string $url, ?string $body = null, array $headers = []): array
{
    $ch = curl_init($url);
    $h = [];
    foreach ($headers as $k => $v) {
        $h[] = "{$k}: {$v}";
    }
    $resHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [...$h, 'Expect:'],
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$resHeaders): int {
            if (($p = strpos($line, ':')) !== false) {
                $resHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            }
            return strlen($line);
        },
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $out = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    return [$status, $out, $resHeaders];
}

$owner = 'user_php_' . bin2hex(random_bytes(3));
$ids = [];

echo "e2e contra {$baseUrl}\n";

T::test('(a) handleUpload create → PUT → complete → 200 AVAILABLE', function () use ($fs, $owner, &$ids): void {
    $bytes = str_repeat('subida por protocolo ' . bin2hex(random_bytes(8)) . "\n", 10);
    $c = $fs->handleUpload(
        json_encode(['action' => 'create', 'name' => 'proto.txt', 'mimeType' => 'text/plain', 'size' => strlen($bytes), 'metadata' => ['origen' => 'php']]),
        $owner,
    );
    T::eq(200, $c->status, $c->json());
    $created = json_decode($c->json(), true); // tal como lo recibe el navegador
    T::eq('simple', $created['upload']['mode']);
    [$st] = http('PUT', $created['upload']['url'], $bytes, $created['upload']['headers']);
    T::eq(200, $st, 'PUT al storage');

    $done = $fs->handleUpload(['action' => 'complete', 'id' => $created['id'], 'token' => $created['token']], $owner);
    T::eq(200, $done->status, $done->json());
    T::eq(FileStatus::Available, $done->file?->status);
    T::eq('AVAILABLE', $done->body['status']);
    T::eq($owner, $done->body['ownerRef']);
    T::eq(hash('sha256', $bytes), $done->body['contentHash']);
    T::eq(['origen' => 'php'], $done->file->metadata);
    $ids['proto'] = $created['id'];
    $ids['protoToken'] = $created['token'];
    $ids['protoBytes'] = $bytes;
});

T::test('(b) complete con token de otro owner → 403', function () use ($fs, &$ids): void {
    $r = $fs->handleUpload(['action' => 'complete', 'id' => $ids['proto'], 'token' => $ids['protoToken']], 'user_intruso');
    T::eq(403, $r->status);
    T::eq('forbidden', $r->body['error']['code']);
});

T::test('(c) upload() server-side multipart de ~40 MB desde un archivo → AVAILABLE', function () use ($fs, $owner, &$ids): void {
    $path = tempnam(sys_get_temp_dir(), 'fs-e2e');
    $out = fopen($path, 'wb');
    $ctx = hash_init('sha256');
    for ($i = 0; $i < 40; $i++) {
        $chunk = random_bytes(1 << 20);
        hash_update($ctx, $chunk);
        fwrite($out, $chunk);
    }
    fwrite($out, $tail = random_bytes(12345));
    hash_update($ctx, $tail);
    fclose($out);
    $sha = hash_final($ctx);

    $mem0 = memory_get_peak_usage();
    $t0 = microtime(true);
    $file = $fs->upload('grande.bin', 'application/octet-stream', new SplFileInfo($path), ownerRef: $owner, wait: 120.0);
    $secs = round(microtime(true) - $t0, 1);
    $peakMb = round((memory_get_peak_usage() - $mem0) / 1048576, 1);
    unlink($path);
    T::eq(FileStatus::Available, $file->status);
    T::eq(40 * (1 << 20) + 12345, $file->size);
    T::eq($sha, $file->contentHash);
    T::true($peakMb < 30, "pico de memoria {$peakMb} MB");
    echo "      ({$secs} s, pico de memoria +{$peakMb} MB)\n";
    $ids['big'] = $file->id;
});

T::test('(d) get + descarga, list/listAll, update public/private, delete, restore', function () use ($fs, $owner, &$ids): void {
    $id = $ids['proto'];
    $url = $fs->getDownloadUrl($id, actor: $owner);
    [$st, $got] = http('GET', $url);
    T::eq(200, $st);
    T::eq($ids['protoBytes'], $got, 'misma descarga');

    $page = $fs->list(ownerRef: $owner, limit: 1);
    T::eq(1, count($page->files));
    T::true($page->nextCursor !== null, 'hay más páginas');
    $all = array_map(static fn ($f) => $f->id, iterator_to_array($fs->listAll(ownerRef: $owner, limit: 1), false));
    sort($all);
    $expected = [$ids['proto'], $ids['big']];
    sort($expected);
    T::eq($expected, $all);
    T::true(in_array($id, array_map(static fn ($f) => $f->id, $fs->list(ownerRef: $owner, status: FileStatus::Available)->files), true));

    $pub = $fs->update($id, visibility: Visibility::Public, name: 'renombrado.txt', actor: $owner);
    T::eq(Visibility::Public, $pub->visibility);
    T::eq('renombrado.txt', $pub->name);
    T::true($pub->publicUrl !== null, 'publicUrl');
    $curl = curl_init($pub->publicUrl);
    curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true]);
    T::eq($ids['protoBytes'], curl_exec($curl), 'URL pública entrega los bytes');
    curl_close($curl);
    $fs->update($id, visibility: 'private');
    [$st] = http('GET', $pub->publicUrl);
    T::eq(404, $st, 'URL pública apagada');

    $fs->delete($id, actor: $owner);
    T::true($fs->get($id)->deletedAt !== null, 'en la papelera');
    T::true(in_array($id, array_map(static fn ($f) => $f->id, $fs->list(ownerRef: $owner, trashed: true)->files), true));
    T::throws(FileServiceException::class, fn () => $fs->getDownloadUrl($id), fn (FileServiceException $e) => T::eq('invalid_state', $e->errorCode));
    T::eq(null, $fs->restore($id)->deletedAt);
});

T::test('errores tipados (not_found, unauthorized)', function () use ($fs, $baseUrl): void {
    T::throws(FileServiceException::class, fn () => $fs->get('00000000-0000-7000-8000-000000000000'), function (FileServiceException $e): void {
        T::eq(404, $e->status);
        T::eq('not_found', $e->errorCode);
    });
    T::throws(FileServiceException::class, fn () => (new FileService('fsk_test_mala', $baseUrl))->list(), fn (FileServiceException $e) => T::eq('unauthorized', $e->errorCode));
});

// Limpieza: a la papelera (la purga libera los bytes).
foreach (['proto', 'big'] as $k) {
    if (isset($ids[$k])) {
        try {
            $fs->delete($ids[$k]);
        } catch (Throwable) {
        }
    }
}

T::finish();
