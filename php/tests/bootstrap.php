<?php

// Runner de tests mínimo (sin PHPUnit): autoload PSR-4 + aserciones.

declare(strict_types=1);

error_reporting(E_ALL);
set_error_handler(static function (int $no, string $msg, string $file, int $line): bool {
    if ((error_reporting() & $no) === 0) {
        return false; // suprimido con @
    }
    throw new ErrorException($msg, 0, $no, $file, $line);
});

spl_autoload_register(static function (string $class): void {
    $prefix = 'Ntropix\\FileService\\';
    if (str_starts_with($class, $prefix)) {
        $path = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});

final class T
{
    public static int $passed = 0;
    public static int $failed = 0;

    public static function test(string $name, callable $fn): void
    {
        try {
            $fn();
            self::$passed++;
            echo "  ✓ {$name}\n";
        } catch (Throwable $e) {
            self::$failed++;
            echo "  ✗ {$name}\n      " . get_class($e) . ': ' . $e->getMessage()
                . "\n      en " . $e->getFile() . ':' . $e->getLine() . "\n";
        }
    }

    public static function eq(mixed $expected, mixed $actual, string $msg = ''): void
    {
        if ($expected !== $actual) {
            throw new RuntimeException(($msg !== '' ? "{$msg}: " : '') . 'esperado ' . var_export($expected, true)
                . ', obtenido ' . var_export($actual, true));
        }
    }

    public static function true(bool $cond, string $msg = 'condición falsa'): void
    {
        if (!$cond) {
            throw new RuntimeException($msg);
        }
    }

    /** @param class-string<Throwable> $class */
    public static function throws(string $class, callable $fn, ?callable $check = null): void
    {
        try {
            $fn();
        } catch (Throwable $e) {
            if (!$e instanceof $class) {
                throw new RuntimeException("se esperaba {$class}, se lanzó " . get_class($e) . ': ' . $e->getMessage());
            }
            if ($check !== null) {
                $check($e);
            }

            return;
        }
        throw new RuntimeException("se esperaba {$class} y no se lanzó nada");
    }

    public static function finish(): never
    {
        echo "\n" . self::$passed . ' ok, ' . self::$failed . " fallidos\n";
        exit(self::$failed === 0 ? 0 : 1);
    }
}
