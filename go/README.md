# File Service de ntropix — SDK de Go

SDK de servidor para el File Service de ntropix. Solo stdlib, Go ≥ 1.22.

La API key vive **solo en tu backend**. El navegador sube los bytes directo al storage con URLs
firmadas; tu backend expone un único endpoint de subida que habla el
[protocolo del navegador](../PROTOCOL.md) (el mismo en todos los SDKs).

## Instalación

```sh
go get github.com/marcanii/file-service-sdk/go
```

```go
import fileservice "github.com/marcanii/file-service-sdk/go"
```

## Cliente

```go
fs, err := fileservice.New(fileservice.Config{
	APIKey:  os.Getenv("FILE_SERVICE_KEY"), // fsk_live_...
	BaseURL: "https://files.ntropix.dev",
	// HTTPClient: miClient, Timeout: 30 * time.Second, Retries: 2 (defaults)
})
```

Todas las operaciones reciben `context.Context` primero. El Usuario final que origina la acción se
informa con `fileservice.WithActor(ctx, "user_8812")` (header `FS-Actor`, solo auditoría).
Las operaciones idempotentes (todas salvo `CreateUpload`) se reintentan ante errores de red, 429 y
5xx, respetando `Retry-After`.

## Endpoint de subida (navegador → tu backend)

Con `net/http` (o chi, que acepta `http.Handler`):

```go
auth := func(r *http.Request) (string, error) {
	user, err := sessionUser(r) // tu mecanismo: sesión, JWT…
	if err != nil {
		return "", err // → 401 unauthorized
	}
	return user.ID, nil // ownerRef: el token de subida queda atado a este usuario
}

mux.Handle("POST /api/files", fs.UploadHandler(auth, fileservice.HandleOptions{
	// Visibility: fileservice.VisibilityPublic,
	// Metadata:   map[string]any{"origen": "web"}, // gana sobre la del navegador
	// WaitTimeout: 30 * time.Second,               // espera de la verificación en complete
}))
```

Gin y echo pueden envolver el mismo handler (`gin.WrapH(h)`, `echo.WrapHandler(h)`), o usar
`HandleUpload` directo, que nunca devuelve error — todo se traduce a status + body:

```go
// gin
r.POST("/api/files", func(c *gin.Context) {
	body, _ := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
	res := fs.HandleUpload(c.Request.Context(), body, fileservice.HandleOptions{OwnerRef: c.GetString("userID")})
	c.JSON(res.Status, res.Body)
})

// echo
e.POST("/api/files", func(c echo.Context) error {
	body, _ := io.ReadAll(io.LimitReader(c.Request().Body, 1<<20))
	res := fs.HandleUpload(c.Request().Context(), body, fileservice.HandleOptions{OwnerRef: c.Get("userID").(string)})
	return c.JSON(res.Status, res.Body)
})
```

`res.File` trae el archivo cuando la acción fue `complete` (útil para guardarlo en tu base), o el
archivo rechazado en un 422. Respuestas de error al navegador: `ownerRef` vacío → 401, token
inválido/vencido/de otro usuario → 403, contenido rechazado → 422, API key del backend rechazada o
File Service inalcanzable → 502 (con el `code` original), el resto de los errores de la API se
propaga tal cual.

## Lado navegador

```ts
import { upload } from "@ntropix/file-service/browser";

const file = await upload(input.files[0], {
  endpoint: "/api/files",
  onProgress: (p) => setProgress(p.percent),
});
// file.status === "AVAILABLE" → file.id para guardar
```

## Subida desde el servidor

Para archivos que genera el backend. Elige simple o multipart (lotes de 100 partes) y lee el
`Body` por partes, sin cargarlo entero en memoria; con un `io.ReaderAt` (`*os.File`,
`*bytes.Reader`) además reintenta los PUT fallidos.

```go
f, _ := os.Open("informe.pdf")
defer f.Close()
file, err := fs.Upload(ctx, fileservice.UploadInput{
	Name: "informe.pdf", MimeType: "application/pdf", Body: f, OwnerRef: "user_8812",
}) // espera a AVAILABLE salvo NoWait: true
```

## Descarga y gestión

```go
url, err := fs.DownloadURL(ctx, id, fileservice.GetOptions{Inline: true}) // URL firmada corta
file, err := fs.Get(ctx, id, fileservice.GetOptions{})
files, next, err := fs.List(ctx, fileservice.ListOptions{OwnerRef: "user_8812", Limit: 50})
err = fs.ListAll(ctx, fileservice.ListOptions{OwnerRef: "user_8812"}, func(f *fileservice.File) error { return nil })
file, err = fs.Update(ctx, id, fileservice.UpdateInput{Visibility: fileservice.VisibilityPublic}) // file.PublicURL
err = fs.Delete(ctx, id)        // papelera
file, err = fs.Restore(ctx, id) // la recupera
```

## Webhooks

```go
http.HandleFunc("POST /webhooks/files", func(w http.ResponseWriter, r *http.Request) {
	payload, _ := io.ReadAll(r.Body) // body CRUDO, sin parsear
	ev, err := fileservice.VerifyWebhook(payload, r.Header.Get("FS-Signature"), secret, 0) // 0 = 300 s
	if err != nil { // errors.Is(err, fileservice.ErrInvalidSignature) para errores de firma
		http.Error(w, "firma inválida", http.StatusBadRequest)
		return
	}
	// at-least-once: descartar duplicados por ev.ID
	if ev.Type == fileservice.EventFileAvailable { /* ev.File */ }
	w.WriteHeader(http.StatusNoContent)
})
```

## Errores

```go
var apiErr *fileservice.Error      // Status, Code, Message, RequestID
var rejected *fileservice.RejectedError // File: quedó QUARANTINED o FAILED
switch {
case errors.As(err, &rejected):
	log.Printf("rechazado: %s", rejected.File.Status)
case errors.As(err, &apiErr) && apiErr.Code == fileservice.CodeNotFound:
	// ...
}
```

`Code` es estable: `validation`, `unauthorized`, `forbidden`, `not_found`, `invalid_state`,
`no_bytes`, `too_large`, `type_not_allowed`, `quota_exceeded`, `storage_full`, `rate_limited`,
`internal`, y los del SDK `network` / `timeout` (Status 0) y `storage_rejected`.
`RejectedError` también se ve como `*Error` 422 (`quarantined` / `failed`).

`RequestID` es el `X-Request-ID` de la respuesta (vacío en `network` / `timeout`) y aparece en
`err.Error()`: logueálo e incluilo al reportar un problema.

## Tests

```sh
go test ./...                                     # unitarios (incluye ../testdata/vectors.json)
FS_KEY=fsk_test_... go test -tags e2e ./...       # contra un stack real (FS_URL, default localhost:8080)
```

Licencia MIT.
