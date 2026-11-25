<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * Visibilidad de un file: `private` (solo con URL firmada) o `public` (URL estable sin credencial).
 */
enum Visibility: string
{
    case Private = 'private';
    case Public = 'public';
    /** Visibilidad que este SDK no conoce (el servicio agregó una nueva). */
    case Unknown = 'unknown';
}
