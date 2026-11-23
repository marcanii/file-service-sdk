package fileservice

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// UploadInput son los datos de [Client.Upload].
type UploadInput struct {
	// Name es el nombre original del archivo (sin rutas).
	Name string
	// MimeType es el tipo declarado. El servicio verifica después el tipo real del contenido.
	MimeType string
	// Size es el tamaño exacto en bytes. Si es 0 se toma de Body cuando se puede
	// (*bytes.Reader, *strings.Reader, *io.SectionReader, *os.File).
	Size int64
	// Body es el contenido. Si además implementa io.ReaderAt (*os.File, *bytes.Reader…), las partes
	// se leen con ReadAt desde el offset 0 y los PUT fallidos se reintentan; si no, se lee en
	// secuencia, con a lo sumo una parte (8 MB) en memoria.
	Body io.Reader
	// OwnerRef es el id del Usuario final en tu sistema.
	OwnerRef string
	// Visibility: VisibilityPrivate (default) o VisibilityPublic.
	Visibility Visibility
	// Metadata son datos propios del Proyecto (JSON, hasta 16 KB).
	Metadata map[string]any
	// NoWait devuelve apenas se completa la subida (archivo en READY), sin esperar la verificación.
	NoWait bool
	// WaitTimeout es el máximo de espera de la verificación (default 30 s).
	WaitTimeout time.Duration
}

// Upload sube un archivo desde el servidor (por ejemplo uno generado por el backend) y, salvo
// NoWait, espera a que quede disponible. Elige subida simple o multipart según lo que indique el
// servicio, y en multipart firma las partes en lotes de 100.
//
// Para archivos de los usuarios preferí la subida directa desde el navegador
// ([Client.UploadHandler]): así los bytes no pasan por tu backend.
func (c *Client) Upload(ctx context.Context, in UploadInput) (*File, error) {
	if in.Body == nil {
		return nil, &Error{Code: CodeValidation, Message: "falta Body"}
	}
	size, err := uploadSize(in)
	if err != nil {
		return nil, err
	}
	created, err := c.CreateUpload(ctx, CreateUploadInput{
		Name: in.Name, MimeType: in.MimeType, Size: size,
		OwnerRef: in.OwnerRef, Visibility: in.Visibility, Metadata: in.Metadata,
	})
	if err != nil {
		return nil, err
	}
	up := created.Upload
	ra, seekable := in.Body.(io.ReaderAt)

	var parts []Part
	switch up.Mode {
	case ModeSimple:
		var newBody func() io.Reader
		if seekable {
			newBody = func() io.Reader { return io.NewSectionReader(ra, 0, size) }
		} else {
			newBody = onceReader(io.LimitReader(in.Body, size))
		}
		if _, err := c.put(ctx, up.URL, newBody, seekable, size, up.Headers); err != nil {
			return nil, err
		}
	case ModeMultipart:
		if parts, err = c.uploadParts(ctx, created.ID, up, size, in.Body, ra, seekable); err != nil {
			return nil, err
		}
	default:
		return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("modo de subida desconocido: %q", up.Mode)}
	}
	return c.Complete(ctx, created.ID, CompleteOptions{Parts: parts, Wait: !in.NoWait, WaitTimeout: in.WaitTimeout})
}

// uploadParts sube las partes en orden, firmando las URLs en lotes de hasta 100.
func (c *Client) uploadParts(ctx context.Context, id string, up UploadInstructions, size int64,
	body io.Reader, ra io.ReaderAt, seekable bool) ([]Part, error) {
	if up.PartSize <= 0 || up.PartCount <= 0 {
		return nil, &Error{Code: CodeInternal, Message: "instrucciones multipart inválidas: faltan las partes"}
	}
	var buf []byte
	if !seekable {
		buf = make([]byte, up.PartSize)
	}
	parts := make([]Part, 0, up.PartCount)
	for start := 1; start <= up.PartCount; start += maxPartsPerBatch {
		numbers := make([]int, 0, maxPartsPerBatch)
		for n := start; n <= up.PartCount && n < start+maxPartsPerBatch; n++ {
			numbers = append(numbers, n)
		}
		urls, err := c.SignParts(ctx, id, numbers)
		if err != nil {
			return nil, err
		}
		// La lectura secuencial necesita las partes en orden.
		sort.Slice(urls, func(i, j int) bool { return urls[i].PartNumber < urls[j].PartNumber })
		for _, u := range urls {
			off := int64(u.PartNumber-1) * up.PartSize
			n := min(up.PartSize, size-off)
			if n <= 0 {
				return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("parte %d fuera del tamaño del archivo", u.PartNumber)}
			}
			var newBody func() io.Reader
			if seekable {
				newBody = func() io.Reader { return io.NewSectionReader(ra, off, n) }
			} else {
				if _, err := io.ReadFull(body, buf[:n]); err != nil {
					return nil, &Error{Code: CodeValidation, Message: "Body tiene menos bytes que Size: " + err.Error()}
				}
				chunk := buf[:n]
				newBody = func() io.Reader { return bytes.NewReader(chunk) }
			}
			etag, err := c.put(ctx, u.URL, newBody, true, n, nil)
			if err != nil {
				return nil, err
			}
			parts = append(parts, Part{PartNumber: u.PartNumber, ETag: etag})
		}
	}
	return parts, nil
}

// put sube bytes a una URL firmada del storage y devuelve el ETag (sin comillas). Si el body se
// puede volver a leer (retryable), reintenta ante fallas de red y 5xx.
func (c *Client) put(ctx context.Context, url string, newBody func() io.Reader, retryable bool,
	size int64, headers map[string]string) (string, error) {
	attempts := 1
	if retryable {
		attempts = c.retries + 1
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		etag, status, err := c.putOnce(ctx, url, newBody(), size, headers)
		if err == nil {
			return etag, nil
		}
		if ctx.Err() != nil {
			return "", fmt.Errorf("fileservice: %w", ctx.Err())
		}
		lastErr = err
		if status != 0 && status < 500 {
			return "", err
		}
		if attempt < attempts {
			if err := sleep(ctx, c.backoff(attempt)); err != nil {
				return "", err
			}
		}
	}
	return "", lastErr
}

func (c *Client) putOnce(ctx context.Context, url string, body io.Reader, size int64, headers map[string]string) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, "PUT", url, body)
	if err != nil {
		return "", 0, &Error{Code: CodeStorageRejected, Message: "URL de subida inválida: " + err.Error()}
	}
	// El storage exige Content-Length: sin esto Go mandaría chunked.
	req.ContentLength = size
	if size == 0 {
		req.Body = http.NoBody
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return "", 0, &Error{Code: CodeNetwork, Message: "no se pudo subir al storage: " + err.Error()}
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", res.StatusCode, &Error{Status: res.StatusCode, Code: CodeStorageRejected,
			Message: fmt.Sprintf("el storage rechazó la subida (HTTP %d)", res.StatusCode)}
	}
	return strings.Trim(res.Header.Get("ETag"), `"`), res.StatusCode, nil
}

// uploadSize resuelve el tamaño de la subida: el declarado o, si es 0, el del Body.
func uploadSize(in UploadInput) (int64, error) {
	if in.Size > 0 {
		return in.Size, nil
	}
	switch b := in.Body.(type) {
	case interface{ Size() int64 }:
		return b.Size(), nil
	case *os.File:
		st, err := b.Stat()
		if err != nil {
			return 0, fmt.Errorf("fileservice: no se pudo obtener el tamaño del archivo: %w", err)
		}
		return st.Size(), nil
	}
	return 0, &Error{Code: CodeValidation, Message: "falta Size: no se puede deducir del Body"}
}

// onceReader envuelve un io.Reader que solo se puede leer una vez (sin reintentos posibles).
func onceReader(r io.Reader) func() io.Reader {
	used := false
	return func() io.Reader {
		if used {
			return errReader{errors.New("el body no se puede releer")}
		}
		used = true
		return r
	}
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }
