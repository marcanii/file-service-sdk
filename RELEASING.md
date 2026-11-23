# Publicar los SDKs

Este repo es un **espejo**: la fuente de verdad vive junto al servicio (privado), donde la API y los
SDKs cambian en el mismo PR y el e2e los prueba juntos. No editar acá directamente.

## Configuración única

| Registry | Qué hacer una sola vez |
|---|---|
| **npm** | Crear la organización `ntropix` en npmjs.com. Generar un token *Automation* y guardarlo como secret `NPM_TOKEN` en este repo de GitHub. |
| **PyPI** | Crear cuenta en pypi.org. En *Publishing → Add a pending publisher*: proyecto `ntropix-file-service`, repo `marcanii/file-service-sdk`, workflow `publish.yml`, environment `pypi`. Sin tokens (OIDC). |
| **Packagist** | Crear cuenta en packagist.org → *Submit* con la URL de este repo. Activar el hook de GitHub (Packagist lo ofrece) para que cada tag se publique solo. |
| **Go** | Nada: `go get` lee directo de GitHub; pkg.go.dev indexa solo. |

## Publicar una versión

Subir la versión en el archivo del paquete (salvo Go y PHP, que se versionan solo por tag) y crear
el tag correspondiente. El workflow `publish.yml` hace el resto.

| SDK | Versión en | Tag |
|---|---|---|
| JS | `js/package.json` | `js/v1.2.3` |
| Python | `python/pyproject.toml` | `python/v1.2.3` |
| Go | — | `go/v1.2.3` |
| PHP | — | `v1.2.3` (Packagist solo entiende tags sin prefijo) |

```bash
git tag js/v1.0.0 && git push origin js/v1.0.0
```

Versionado semántico: un cambio incompatible del protocolo o de la API sube el major de todos los SDKs.
