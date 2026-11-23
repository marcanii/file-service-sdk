package fileservice

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// CreateUploadInput son los datos para iniciar una subida.
type CreateUploadInput struct {
	// Name es el nombre original del archivo (sin rutas).
	Name string
	// MimeType es el tipo declarado. El servicio verifica después el tipo real del contenido.
	MimeType string
	// Size es el tamaño exacto en bytes. El storage rechaza una subida de otro tamaño.
	Size int64
	// OwnerRef es el id del Usuario final en tu sistema: permite listar y auditar por usuario.
	OwnerRef string
	// Visibility: VisibilityPrivate (default) o VisibilityPublic.
	Visibility Visibility
	// Metadata son datos propios del Proyecto (JSON, hasta 16 KB).
	Metadata map[string]any
}

// CompleteOptions configura [Client.Complete].
type CompleteOptions struct {
	// Parts es obligatorio en subidas multipart: las partes con sus ETags.
	Parts []Part
	// Wait espera a que el archivo quede verificado antes de devolver. Si termina en FAILED o
	// QUARANTINED devuelve *RejectedError.
	Wait bool
	// WaitTimeout es el máximo de espera con Wait (default 30 s).
	WaitTimeout time.Duration
}

// GetOptions configura [Client.Get] y [Client.DownloadURL].
type GetOptions struct {
	// Inline pide que el navegador muestre el archivo en vez de bajarlo (solo imágenes, video,
	// audio y PDF; el resto siempre baja como adjunto).
	Inline bool
}

// WaitOptions configura [Client.WaitUntilAvailable].
type WaitOptions struct {
	// Timeout es el máximo de espera (default 30 s).
	Timeout time.Duration
	// Interval es el intervalo inicial entre consultas (default 500 ms; crece ×1.5 hasta 3 s).
	Interval time.Duration
}

// ListOptions filtra y pagina [Client.List].
type ListOptions struct {
	OwnerRef string
	Status   FileStatus
	// Trashed lista la papelera; por defecto se listan los archivos vivos.
	Trashed bool
	// Cursor es el nextCursor de la página anterior.
	Cursor string
	// Limit es el tamaño de página (default 50, máximo 200).
	Limit int
}

// UpdateInput son los cambios de [Client.Update]. Los campos vacíos no se tocan.
type UpdateInput struct {
	Visibility Visibility
	Name       string
}

// CreateUpload inicia una subida. Devuelve el id del archivo y las instrucciones para subir los
// bytes directo al storage; después hay que llamar a [Client.Complete].
//
// No se reintenta: repetirla crearía un archivo huérfano.
func (c *Client) CreateUpload(ctx context.Context, in CreateUploadInput) (*CreatedUpload, error) {
	body := struct {
		Name       string         `json:"original_name"`
		MimeType   string         `json:"mime_type"`
		Size       int64          `json:"size_bytes"`
		OwnerRef   string         `json:"owner_ref,omitempty"`
		Visibility Visibility     `json:"visibility,omitempty"`
		Metadata   map[string]any `json:"metadata,omitempty"`
	}{in.Name, in.MimeType, in.Size, in.OwnerRef, in.Visibility, in.Metadata}
	var raw struct {
		ID     string     `json:"id"`
		Status FileStatus `json:"status"`
		Upload wireUpload `json:"upload"`
	}
	if err := c.do(ctx, "POST", "/files", body, false, &raw); err != nil {
		return nil, err
	}
	return &CreatedUpload{ID: raw.ID, Status: raw.Status, Upload: raw.Upload.toInstructions()}, nil
}

// SignParts firma las URLs de un lote de partes de una subida multipart (hasta 100 por llamada).
// Las URLs se piden bajo demanda para que no caduquen en subidas lentas.
func (c *Client) SignParts(ctx context.Context, id string, partNumbers []int) ([]PartURL, error) {
	body := struct {
		PartNumbers []int `json:"part_numbers"`
	}{partNumbers}
	var raw struct {
		URLs []struct {
			PartNumber int    `json:"part_number"`
			URL        string `json:"url"`
		} `json:"urls"`
	}
	if err := c.do(ctx, "POST", filePath(id, "/parts"), body, true, &raw); err != nil {
		return nil, err
	}
	urls := make([]PartURL, len(raw.URLs))
	for i, u := range raw.URLs {
		urls[i] = PartURL{PartNumber: u.PartNumber, URL: u.URL}
	}
	return urls, nil
}

// Complete cierra la subida: el servicio comprueba que los bytes estén en el storage y encola la
// verificación. Es idempotente. Con opts.Wait espera a que el archivo quede AVAILABLE.
func (c *Client) Complete(ctx context.Context, id string, opts CompleteOptions) (*File, error) {
	var body any
	if len(opts.Parts) > 0 {
		type wirePart struct {
			PartNumber int    `json:"part_number"`
			ETag       string `json:"etag"`
		}
		parts := make([]wirePart, len(opts.Parts))
		for i, p := range opts.Parts {
			parts[i] = wirePart{p.PartNumber, strings.Trim(p.ETag, `"`)}
		}
		body = struct {
			Parts []wirePart `json:"parts"`
		}{parts}
	}
	var raw wireFile
	if err := c.do(ctx, "POST", filePath(id, "/complete"), body, true, &raw); err != nil {
		return nil, err
	}
	if !opts.Wait {
		return raw.toFile(), nil
	}
	return c.WaitUntilAvailable(ctx, id, WaitOptions{Timeout: opts.WaitTimeout})
}

// Get devuelve los metadatos del archivo y, si está disponible, una URL firmada de descarga de
// vida corta (File.Download). Cada emisión de URL queda auditada como descarga.
func (c *Client) Get(ctx context.Context, id string, opts GetOptions) (*File, error) {
	path := filePath(id, "")
	if opts.Inline {
		path += "?disposition=inline"
	}
	var raw wireFile
	if err := c.do(ctx, "GET", path, nil, true, &raw); err != nil {
		return nil, err
	}
	return raw.toFile(), nil
}

// DownloadURL es un atajo a la URL firmada de descarga. Si el archivo no está disponible devuelve
// *Error con Code invalid_state (409).
func (c *Client) DownloadURL(ctx context.Context, id string, opts GetOptions) (string, error) {
	f, err := c.Get(ctx, id, opts)
	if err != nil {
		return "", err
	}
	if f.Download == nil {
		return "", &Error{Status: 409, Code: CodeInvalidState,
			Message: fmt.Sprintf("el archivo no está disponible para descarga (estado %s)", f.Status)}
	}
	return f.Download.URL, nil
}

// WaitUntilAvailable consulta el archivo hasta que el worker termine de verificarlo. Devuelve el
// archivo AVAILABLE (con Download), *RejectedError si quedó FAILED/QUARANTINED, o *Error con Code
// timeout si la verificación no terminó a tiempo (sigue en curso: consultá más tarde o usá el
// webhook).
func (c *Client) WaitUntilAvailable(ctx context.Context, id string, opts WaitOptions) (*File, error) {
	f, _, err := c.wait(ctx, id, opts)
	return f, err
}

// wait implementa WaitUntilAvailable; si vence el plazo devuelve además el último estado visto.
func (c *Client) wait(ctx context.Context, id string, opts WaitOptions) (last *File, timedOut bool, err error) {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultWaitTimeout
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = defaultWaitInterval
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := c.Get(ctx, id, GetOptions{})
		if err != nil {
			return nil, false, err
		}
		switch f.Status {
		case StatusAvailable:
			return f, false, nil
		case StatusFailed, StatusQuarantined:
			return nil, false, &RejectedError{File: f}
		}
		if time.Now().Add(interval).After(deadline) {
			return f, true, &Error{Code: CodeTimeout, Message: fmt.Sprintf(
				"el archivo sigue en %s: la verificación no terminó a tiempo (sigue en curso; consultá más tarde o usá el webhook)", f.Status)}
		}
		if err := sleep(ctx, interval); err != nil {
			return nil, false, err
		}
		interval = min(time.Duration(float64(interval)*1.5), maxWaitInterval)
	}
}

// List devuelve una página de archivos del Proyecto, del más nuevo al más viejo, y el cursor de
// la página siguiente ("" si no hay más). No incluye URLs de descarga.
func (c *Client) List(ctx context.Context, opts ListOptions) ([]*File, string, error) {
	q := url.Values{}
	if opts.OwnerRef != "" {
		q.Set("owner_ref", opts.OwnerRef)
	}
	if opts.Status != "" {
		q.Set("status", string(opts.Status))
	}
	if opts.Trashed {
		q.Set("trashed", "true")
	}
	if opts.Cursor != "" {
		q.Set("cursor", opts.Cursor)
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	path := "/files"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var raw struct {
		Files      []wireFile `json:"files"`
		NextCursor string     `json:"next_cursor"`
	}
	if err := c.do(ctx, "GET", path, nil, true, &raw); err != nil {
		return nil, "", err
	}
	files := make([]*File, len(raw.Files))
	for i := range raw.Files {
		files[i] = raw.Files[i].toFile()
	}
	return files, raw.NextCursor, nil
}

// ListAll recorre todas las páginas de [Client.List] (ignora opts.Cursor) y llama a fn con cada
// archivo. Si fn devuelve un error, la iteración se corta y ListAll lo devuelve tal cual.
func (c *Client) ListAll(ctx context.Context, opts ListOptions, fn func(*File) error) error {
	opts.Cursor = ""
	for {
		files, next, err := c.List(ctx, opts)
		if err != nil {
			return err
		}
		for _, f := range files {
			if err := fn(f); err != nil {
				return err
			}
		}
		if next == "" {
			return nil
		}
		opts.Cursor = next
	}
}

// Update cambia la visibilidad y/o el nombre. Hacer público o privado un archivo es instantáneo.
func (c *Client) Update(ctx context.Context, id string, in UpdateInput) (*File, error) {
	body := struct {
		Visibility Visibility `json:"visibility,omitempty"`
		Name       string     `json:"original_name,omitempty"`
	}{in.Visibility, in.Name}
	var raw wireFile
	if err := c.do(ctx, "PATCH", filePath(id, ""), body, true, &raw); err != nil {
		return nil, err
	}
	return raw.toFile(), nil
}

// Delete manda el archivo a la papelera. Se puede recuperar con [Client.Restore] durante el
// período de retención del Proyecto.
func (c *Client) Delete(ctx context.Context, id string) error {
	return c.do(ctx, "DELETE", filePath(id, ""), nil, true, nil)
}

// Restore recupera un archivo de la papelera.
func (c *Client) Restore(ctx context.Context, id string) (*File, error) {
	var raw wireFile
	if err := c.do(ctx, "POST", filePath(id, "/restore"), nil, true, &raw); err != nil {
		return nil, err
	}
	return raw.toFile(), nil
}

func filePath(id, suffix string) string {
	return "/files/" + url.PathEscape(id) + suffix
}
