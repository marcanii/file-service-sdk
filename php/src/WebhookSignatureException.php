<?php

declare(strict_types=1);

namespace Ntropix\FileService;

/**
 * La firma del webhook falta, no coincide, o el evento es demasiado viejo.
 */
final class WebhookSignatureException extends \RuntimeException
{
}
