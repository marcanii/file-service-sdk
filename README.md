# SDKs del ntropix File Service

Clientes oficiales del File Service de ntropix. Subí, verificá y serví archivos desde cualquier
backend; los bytes viajan directo del navegador al storage.

| Lenguaje | Paquete | Instalar | Guía |
|---|---|---|---|
| Node / TypeScript (Next.js, NestJS, Express, Hono…) | `@ntropix/file-service` | `npm install @ntropix/file-service` | [js/](./js) |
| Python (FastAPI, Django, Flask) | `ntropix-file-service` | desde GitHub, ver [python/](./python#instalación) | [python/](./python) |
| Go (net/http, gin, echo) | `github.com/marcanii/file-service-sdk/go` | `go get github.com/marcanii/file-service-sdk/go` | [go/](./go) |
| PHP (Laravel, Symfony) | `ntropix/file-service` | desde GitHub, ver [php/](./php#instalación) | [php/](./php) |
| Navegador (con cualquier backend) | `@ntropix/file-service/browser` | npm, o CDN `https://cdn.jsdelivr.net/npm/@ntropix/file-service@1/dist/browser.js` | [js/](./js#2-navegador-upload) |

## Cómo se integra

1. En el **Panel** del File Service: crear el Proyecto y emitir su API key.
2. En **tu backend**: un endpoint de subida con `handleUpload` del SDK de tu lenguaje. Tu backend
   autentica al usuario; el SDK hace el resto.
3. En **el navegador**: `upload(file, { endpoint: "/api/files" })`.

```
Navegador ── upload(file, { endpoint }) ──▶ Tu backend (handleUpload) ──▶ File Service
    └──────────── bytes directo, con URL firmada ──────────────────────▶ Storage
```

La API key vive solo en tu backend. Todos los SDKs hablan el mismo
[protocolo de subida](./PROTOCOL.md) y pasan los mismos [vectores de prueba](./testdata/vectors.json),
así que el helper de navegador funciona con cualquiera de ellos.

Referencia completa de la API REST (para cualquier otro lenguaje): [`openapi.yaml`](./openapi.yaml),
también navegable en `https://<tu-file-service>/docs`.

## Licencia

[MIT](./LICENSE).
