package fileservice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTimeout      = 30 * time.Second
	defaultRetries      = 2
	defaultWaitTimeout  = 30 * time.Second
	defaultWaitInterval = 500 * time.Millisecond
	maxWaitInterval     = 3 * time.Second
	defaultRetryBase    = 250 * time.Millisecond
	// maxPartsPerBatch es el máximo de partes que la API firma por request.
	maxPartsPerBatch = 100
	// maxResponseBody acota lo que se lee de una respuesta JSON de la API.
	maxResponseBody = 16 << 20
)

// Config configura un [Client]. APIKey y BaseURL son obligatorios.
type Config struct {
	// APIKey del Proyecto (fsk_live_... / fsk_test_...). Nunca debe llegar al navegador.
	APIKey string
	// BaseURL de la API, ej. "https://files.ntropix.dev".
	BaseURL string
	// HTTPClient para hablar con la API y con el storage. Default: un *http.Client nuevo.
	HTTPClient *http.Client
	// Timeout por request a la API (default 30 s). No aplica a los PUT de bytes al storage,
	// que solo respetan el context.
	Timeout time.Duration
	// Retries ante errores de red, 429 y 5xx en operaciones seguras de repetir (todas salvo
	// CreateUpload). 0 usa el default (2); un valor negativo los desactiva.
	Retries int
}

// Client habla con la API del File Service. Es seguro para uso concurrente.
type Client struct {
	apiKey    string
	baseURL   string
	http      *http.Client
	timeout   time.Duration
	retries   int
	retryBase time.Duration
	now       func() time.Time
}

// New crea un cliente. Devuelve error si falta APIKey o BaseURL.
func New(cfg Config) (*Client, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("fileservice: falta APIKey")
	}
	if cfg.BaseURL == "" {
		return nil, errors.New("fileservice: falta BaseURL")
	}
	c := &Client{
		apiKey:    cfg.APIKey,
		baseURL:   strings.TrimRight(cfg.BaseURL, "/"),
		http:      cfg.HTTPClient,
		timeout:   cfg.Timeout,
		retries:   cfg.Retries,
		retryBase: defaultRetryBase,
		now:       time.Now,
	}
	if c.http == nil {
		c.http = &http.Client{}
	}
	if c.timeout <= 0 {
		c.timeout = defaultTimeout
	}
	switch {
	case c.retries == 0:
		c.retries = defaultRetries
	case c.retries < 0:
		c.retries = 0
	}
	return c, nil
}

type actorKey struct{}

// WithActor devuelve un context que informa al servicio qué Usuario final origina la acción
// (header FS-Actor). Solo queda en la auditoría; no cambia permisos.
func WithActor(ctx context.Context, actor string) context.Context {
	return context.WithValue(ctx, actorKey{}, actor)
}

func actorFrom(ctx context.Context) string {
	s, _ := ctx.Value(actorKey{}).(string)
	return s
}

// do ejecuta un request JSON contra la API, con reintentos si idempotent. Si out != nil,
// decodifica en él la respuesta 2xx.
func (c *Client) do(ctx context.Context, method, path string, body any, idempotent bool, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("fileservice: no se pudo serializar el body: %w", err)
		}
	}
	// Solo se reintenta lo que es seguro repetir: crear un archivo dos veces dejaría uno huérfano.
	attempts := 1
	if idempotent {
		attempts = c.retries + 1
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		status, header, data, err := c.roundTrip(ctx, method, path, payload)
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("fileservice: %w", ctx.Err())
			}
			lastErr = err
			if attempt < attempts {
				if err := sleep(ctx, c.backoff(attempt)); err != nil {
					return err
				}
			}
			continue
		}
		if status >= 200 && status < 300 {
			if out == nil || status == http.StatusNoContent || len(data) == 0 {
				return nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return &Error{Status: status, Code: CodeInternal, Message: "respuesta inválida del File Service: " + err.Error()}
			}
			return nil
		}
		apiErr := parseAPIError(status, data)
		retryable := status == http.StatusTooManyRequests || status >= 500
		if !retryable || attempt == attempts {
			return apiErr
		}
		lastErr = apiErr
		wait := retryAfter(header)
		if wait <= 0 {
			wait = c.backoff(attempt)
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
	return lastErr
}

// roundTrip hace un intento con su propio timeout y lee el body completo.
func (c *Client) roundTrip(ctx context.Context, method, path string, payload []byte) (int, http.Header, []byte, error) {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(actx, method, c.baseURL+path, body)
	if err != nil {
		return 0, nil, nil, &Error{Code: CodeNetwork, Message: "request inválido: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if actor := actorFrom(ctx); actor != "" {
		req.Header.Set("FS-Actor", actor)
	}

	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, c.transportError(ctx, actx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBody))
	if err != nil {
		return 0, nil, nil, c.transportError(ctx, actx, err)
	}
	return res.StatusCode, res.Header, data, nil
}

// transportError clasifica un error sin respuesta como timeout (venció el timeout por request)
// o network (cualquier otra falla de conexión).
func (c *Client) transportError(ctx, actx context.Context, err error) error {
	if ctx.Err() == nil && errors.Is(actx.Err(), context.DeadlineExceeded) {
		return &Error{Code: CodeTimeout, Message: fmt.Sprintf("el File Service no respondió en %s", c.timeout)}
	}
	return &Error{Code: CodeNetwork, Message: "no se pudo conectar con el File Service: " + err.Error()}
}

func (c *Client) backoff(attempt int) time.Duration {
	return c.retryBase << (attempt - 1)
}

// parseAPIError traduce el cuerpo {"error":{"code","message"}} de la API a *Error.
func parseAPIError(status int, data []byte) *Error {
	var body struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	e := &Error{Status: status, Code: CodeInternal, Message: fmt.Sprintf("respuesta inesperada del File Service (HTTP %d)", status)}
	if json.Unmarshal(data, &body) == nil && body.Error != nil {
		if body.Error.Code != "" {
			e.Code = body.Error.Code
		}
		if body.Error.Message != "" {
			e.Message = body.Error.Message
		}
	}
	return e
}

// retryAfter interpreta el header Retry-After (segundos o fecha HTTP).
func retryAfter(h http.Header) time.Duration {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		return time.Until(t)
	}
	return 0
}

// sleep espera d o hasta que se cancele el context.
func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("fileservice: %w", ctx.Err())
	}
}
