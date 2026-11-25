<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/** @internal */
final class Json
{
    /**
     * Como `json_decode($s, true)`, pero un objeto vacío anidado (`{"tags":{}}`) se conserva como
     * `stdClass` en vez de degradarse a `[]`, para que `json_encode` lo emita otra vez como `{}`.
     * El valor de nivel superior sí se devuelve como array.
     */
    public static function decode(string $json): mixed
    {
        $value = json_decode($json, false);

        return $value instanceof \stdClass ? self::fromObject($value) : self::walk($value);
    }

    /** @return array<string, mixed> */
    private static function fromObject(\stdClass $o): array
    {
        $out = [];
        foreach (get_object_vars($o) as $k => $v) {
            $out[$k] = self::walk($v);
        }

        return $out;
    }

    private static function walk(mixed $v): mixed
    {
        if ($v instanceof \stdClass) {
            return get_object_vars($v) === [] ? $v : self::fromObject($v);
        }
        if (is_array($v)) {
            return array_map(self::walk(...), $v);
        }

        return $v;
    }
}
