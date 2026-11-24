# Publicar los SDKs

Este repo es un **espejo**: la fuente de verdad vive junto al servicio (privado), donde la API y los
SDKs cambian en el mismo PR y el e2e los prueba juntos. No editar acá directamente.

## Configuración única

npm y PyPI publican con **trusted publishing (OIDC)**: GitHub Actions se identifica ante el registry y
publica sin ningún token guardado en el repo (npm revocó los tokens clásicos en diciembre de 2025).

| Registry | Qué hacer una sola vez |
|---|---|
| **npm** | Cuenta en npmjs.com con 2FA. Crear la organización `ntropix` (plan gratuito: alcanza para paquetes públicos). En el paquete `@ntropix/file-service` → *Settings → Trusted publishing*: GitHub Actions, owner `marcanii`, repo `file-service-sdk`, workflow `publish.yml`, sin environment. Una configuración nueva tiene que publicar **dentro de los 2 días** o vence. Si la web no deja configurarlo para un paquete que todavía no existe, publicar la primera versión a mano (`cd js && npm login && pnpm install && pnpm build && pnpm test && npm publish --access public`) y configurarlo después. |
| **PyPI** | Cuenta en pypi.org con 2FA. En *Your projects → Publishing → Add a pending publisher*: proyecto `ntropix-file-service`, owner `marcanii`, repo `file-service-sdk`, workflow `publish.yml`, environment `pypi`. En GitHub: *Settings → Environments → New environment* `pypi`. |
| **Packagist** | Entrar a packagist.org con GitHub → *Submit* con la URL de este repo. Activar la integración con GitHub que ofrece, para que cada tag se publique solo. |
| **Go** | Nada: `go get` lee directo de GitHub; pkg.go.dev indexa solo. |

## Publicar una versión

Los cambios llegan por PR a `develop` (desde la fuente de verdad) y se publican desde `main`:

1. Subir la versión en el archivo del paquete (salvo Go y PHP, que se versionan solo por tag).
2. PR `develop → main` y merge.
3. Sobre `main`, crear los tags. `publish.yml` verifica que la versión del tag coincida con la del
   paquete, corre los tests y publica npm y PyPI; Packagist y Go toman el tag solos.

| SDK | Versión en | Tag |
|---|---|---|
| JS | `js/package.json` | `js/v1.2.3` |
| Python | `python/pyproject.toml` | `python/v1.2.3` |
| Go | — | `go/v1.2.3` |
| PHP | — | `v1.2.3` (Packagist solo entiende tags sin prefijo) |

```bash
git checkout main && git pull
git tag js/v1.1.0 && git tag python/v1.1.0 && git tag go/v1.1.0 && git tag v1.1.0
git push origin js/v1.1.0 python/v1.1.0 go/v1.1.0 v1.1.0

# opcional: que pkg.go.dev lo indexe enseguida
GOPROXY=https://proxy.golang.org go list -m github.com/marcanii/file-service-sdk/go@v1.1.0
```

Versionado semántico: un cambio incompatible del protocolo o de la API sube el major de todos los SDKs.
