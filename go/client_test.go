package fileservice

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNew_Validation(t *testing.T) {
	if _, err := New(Config{BaseURL: "http://x"}); err == nil {
		t.Error("sin APIKey debería fallar")
	}
	if _, err := New(Config{APIKey: "k"}); err == nil {
		t.Error("sin BaseURL debería fallar")
	}
	c, _ := New(Config{APIKey: "k", BaseURL: "http://x", Retries: -1})
	if c.retries != 0 || c.timeout != defaultTimeout {
		t.Errorf("retries=%d timeout=%s", c.retries, c.timeout)
	}
}

func TestGet_RetriesAndActor(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("FS-Actor") != "user_7" {
			t.Errorf("FS-Actor = %q", r.Header.Get("FS-Actor"))
		}
		if r.URL.RawQuery != "disposition=inline" {
			t.Errorf("query = %q", r.URL.RawQuery)
		}
		if calls.Add(1) < 3 {
			apiError(w, 429, "rate_limited", "despacio")
			return
		}
		f := wireFileJSON("f1", "AVAILABLE")
		f["download"] = map[string]any{"url": "http://storage/get", "expires_at": "2026-11-10T12:05:00Z"}
		writeJSON(w, 200, f)
	}))
	ctx := WithActor(context.Background(), "user_7")
	url, err := c.DownloadURL(ctx, "f1", GetOptions{Inline: true})
	if err != nil || url != "http://storage/get" {
		t.Fatalf("url=%q err=%v", url, err)
	}
	if calls.Load() != 3 {
		t.Errorf("llamadas = %d", calls.Load())
	}
}

func TestErrors_GiveUpAfterRetries(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(502)
	}))
	_, err := c.Get(context.Background(), "f1", GetOptions{})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 502 || apiErr.Code != CodeInternal {
		t.Fatalf("err = %v", err)
	}
	if calls.Load() != 3 {
		t.Errorf("llamadas = %d, esperado 1 + 2 reintentos", calls.Load())
	}
}

func TestErrors_NotFoundNotRetried(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		apiError(w, 404, "not_found", "file no encontrado")
	}))
	err := c.Delete(context.Background(), "nope")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != CodeNotFound || calls.Load() != 1 {
		t.Fatalf("err = %v, llamadas %d", err, calls.Load())
	}
}

func TestErrors_ExposeRequestID(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", "req-123")
		apiError(w, 404, "not_found", "file no encontrado")
	}))
	_, err := c.Get(context.Background(), "f1", GetOptions{})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.RequestID != "req-123" {
		t.Fatalf("err = %#v, quiero RequestID req-123", err)
	}

	offline, _ := New(Config{APIKey: "k", BaseURL: "http://127.0.0.1:9", Retries: -1})
	_, err = offline.Get(context.Background(), "f1", GetOptions{})
	if !errors.As(err, &apiErr) || apiErr.Code != CodeNetwork || apiErr.RequestID != "" {
		t.Fatalf("sin respuesta no hay Request ID: %#v", err)
	}
}

func TestTimeoutPerRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()
	c, _ := New(Config{APIKey: "k", BaseURL: srv.URL, Timeout: 20 * time.Millisecond, Retries: -1})
	_, err := c.Get(context.Background(), "f1", GetOptions{})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != CodeTimeout || apiErr.Status != 0 {
		t.Fatalf("err = %v", err)
	}
}

func TestWaitUntilAvailable_Rejected(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, wireFileJSON("f1", "FAILED"))
	}))
	_, err := c.Complete(context.Background(), "f1", CompleteOptions{Wait: true})
	var rej *RejectedError
	if !errors.As(err, &rej) || rej.File.Status != StatusFailed || rej.Code() != CodeFailed {
		t.Fatalf("err = %v", err)
	}
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 422 || apiErr.Code != CodeFailed {
		t.Fatalf("RejectedError debería verse como *Error 422: %v", apiErr)
	}
}

func TestWaitUntilAvailable_Timeout(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, wireFileJSON("f1", "READY"))
	}))
	_, err := c.WaitUntilAvailable(context.Background(), "f1", WaitOptions{Timeout: 50 * time.Millisecond, Interval: 10 * time.Millisecond})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != CodeTimeout {
		t.Fatalf("err = %v", err)
	}
}

func TestListAll_Paginates(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("owner_ref") != "u" || q.Get("trashed") != "true" || q.Get("limit") != "2" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		switch q.Get("cursor") {
		case "":
			writeJSON(w, 200, map[string]any{"files": []any{wireFileJSON("a", "AVAILABLE"), wireFileJSON("b", "AVAILABLE")}, "next_cursor": "b"})
		case "b":
			writeJSON(w, 200, map[string]any{"files": []any{wireFileJSON("c", "AVAILABLE")}})
		default:
			t.Errorf("cursor inesperado %q", q.Get("cursor"))
		}
	}))
	var ids []string
	err := c.ListAll(context.Background(), ListOptions{OwnerRef: "u", Trashed: true, Limit: 2}, func(f *File) error {
		ids = append(ids, f.ID)
		return nil
	})
	if err != nil || strings.Join(ids, ",") != "a,b,c" {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	stop := errors.New("basta")
	n := 0
	err = c.ListAll(context.Background(), ListOptions{OwnerRef: "u", Trashed: true, Limit: 2}, func(*File) error {
		n++
		return stop
	})
	if !errors.Is(err, stop) || n != 1 {
		t.Errorf("corte: err=%v n=%d", err, n)
	}
}

// fakeService simula la API y el storage para Upload.
type fakeService struct {
	t         *testing.T
	partSize  int64
	threshold int64
	mu        sync.Mutex
	received  map[int][]byte
	signCalls int
	completed []map[string]any
	storeFail atomic.Int32
	// storeThenFail: el PUT escribe pero la respuesta "se pierde" (500). Con If-None-Match: * el storage
	// responde 412 si el objeto ya existe, como el real.
	storeThenFail atomic.Int32
	// declared son los sha256 recibidos en cada POST /files ("" si no vino).
	declared []string
}

func (f *fakeService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == "POST" && r.URL.Path == "/files":
		var req struct {
			Size   int64  `json:"size_bytes"`
			SHA256 string `json:"sha256"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.declared = append(f.declared, req.SHA256)
		f.mu.Unlock()
		base := "http://" + r.Host
		if req.Size < f.threshold {
			headers := map[string]string{"Content-Type": "application/octet-stream", "If-None-Match": "*"}
			if req.SHA256 != "" {
				// Como la API: el Checksum declarado va firmado en el PUT, en base64.
				raw, _ := hex.DecodeString(req.SHA256)
				headers["x-amz-checksum-sha256"] = base64.StdEncoding.EncodeToString(raw)
			}
			writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING", "upload": map[string]any{
				"mode": "simple", "url": base + "/storage/0", "headers": headers,
				"expires_at": "2026-11-10T12:15:00Z"}})
			return
		}
		count := (req.Size + f.partSize - 1) / f.partSize
		writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING", "upload": map[string]any{
			"mode": "multipart", "part_size": f.partSize, "part_count": count, "expires_at": "2026-11-10T12:15:00Z"}})
	case r.Method == "POST" && r.URL.Path == "/files/f1/parts":
		var req struct {
			PartNumbers []int `json:"part_numbers"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if len(req.PartNumbers) > 100 {
			f.t.Errorf("lote de %d partes (máx 100)", len(req.PartNumbers))
		}
		f.mu.Lock()
		f.signCalls++
		f.mu.Unlock()
		urls := []map[string]any{}
		for _, n := range req.PartNumbers {
			urls = append(urls, map[string]any{"part_number": n, "url": fmt.Sprintf("http://%s/storage/%d", r.Host, n)})
		}
		writeJSON(w, 200, map[string]any{"urls": urls})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/storage/"):
		if r.ContentLength < 0 {
			f.t.Error("PUT sin Content-Length")
		}
		if f.storeFail.Load() > 0 {
			f.storeFail.Add(-1)
			w.WriteHeader(500)
			return
		}
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/storage/"))
		f.mu.Lock()
		_, exists := f.received[n]
		f.mu.Unlock()
		if exists && r.Header.Get("If-None-Match") == "*" {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		data, _ := io.ReadAll(r.Body)
		if want := r.Header.Get("x-amz-checksum-sha256"); want != "" {
			// Como el storage: un contenido distinto del checksum firmado se rechaza sin escribir.
			sum := sha256.Sum256(data)
			if base64.StdEncoding.EncodeToString(sum[:]) != want {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		f.mu.Lock()
		f.received[n] = data
		f.mu.Unlock()
		if f.storeThenFail.Load() > 0 {
			f.storeThenFail.Add(-1)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("ETag", fmt.Sprintf(`"etag-%d"`, n))
	case r.Method == "POST" && r.URL.Path == "/files/f1/complete":
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.completed = append(f.completed, req)
		writeJSON(w, 200, wireFileJSON("f1", "READY"))
	case r.Method == "GET" && r.URL.Path == "/files/f1":
		writeJSON(w, 200, wireFileJSON("f1", "AVAILABLE"))
	default:
		f.t.Errorf("request inesperado %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}
}

func (f *fakeService) assembled(parts int) []byte {
	var out []byte
	for i := 1; i <= parts; i++ {
		out = append(out, f.received[i]...)
	}
	return out
}

func TestUpload_Multipart(t *testing.T) {
	data := make([]byte, 1050)
	_, _ = rand.Read(data)
	for _, tc := range []struct {
		name string
		body io.Reader
	}{
		{"ReaderAt", bytes.NewReader(data)},
		{"Reader secuencial", io.MultiReader(bytes.NewReader(data))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
			fake.storeFail.Store(1) // el primer PUT falla: debe reintentarse
			c := newTestClient(t, fake)
			f, err := c.Upload(context.Background(), UploadInput{Name: "x.bin", MimeType: "application/octet-stream", Size: int64(len(data)), Body: tc.body})
			if err != nil {
				t.Fatal(err)
			}
			if f.Status != StatusAvailable {
				t.Errorf("status %s", f.Status)
			}
			if !bytes.Equal(fake.assembled(210), data) {
				t.Error("el contenido reensamblado no coincide")
			}
			if fake.signCalls != 3 {
				t.Errorf("firmas = %d, esperado 3 lotes (100+100+10)", fake.signCalls)
			}
			parts := fake.completed[0]["parts"].([]any)
			last := parts[len(parts)-1].(map[string]any)
			if len(parts) != 210 || last["etag"] != "etag-210" || last["part_number"] != float64(210) {
				t.Errorf("complete parts: %d, última %v", len(parts), last)
			}
		})
	}
}

func TestUpload_SimpleSizeFromBody(t *testing.T) {
	fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
	c := newTestClient(t, fake)
	_, err := c.Upload(context.Background(), UploadInput{Name: "a.txt", MimeType: "text/plain", Body: strings.NewReader("hola"), NoWait: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(fake.received[0]) != "hola" {
		t.Errorf("recibido %q", fake.received[0])
	}
	if _, ok := fake.completed[0]["parts"]; ok {
		t.Error("complete simple no debe mandar parts")
	}
}

// Escritura única (If-None-Match: *): si un PUT escribió pero su respuesta se perdió, el reintento
// recibe 412 y eso es éxito, no error: el objeto ya es el de este upload.
func TestUpload_SimpleRetryAfterLostResponseIs412(t *testing.T) {
	fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
	fake.storeThenFail.Store(1)
	c := newTestClient(t, fake)
	_, err := c.Upload(context.Background(), UploadInput{Name: "a.txt", MimeType: "text/plain", Body: strings.NewReader("hola"), NoWait: true})
	if err != nil {
		t.Fatalf("el 412 del reintento debe contar como subido: %v", err)
	}
	if string(fake.received[0]) != "hola" || len(fake.completed) != 1 {
		t.Errorf("recibido %q, completes %d", fake.received[0], len(fake.completed))
	}
}

// Un 412 en el PRIMER intento es una URL ya usada: es error.
func TestUpload_Simple412OnFirstAttemptIsError(t *testing.T) {
	fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{0: []byte("otro")}}
	c := newTestClient(t, fake)
	_, err := c.Upload(context.Background(), UploadInput{Name: "a.txt", MimeType: "text/plain", Body: strings.NewReader("hola"), NoWait: true})
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusPreconditionFailed {
		t.Fatalf("quería error 412, llegó %v", err)
	}
}

func TestRequests_SendUserAgent(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("User-Agent"); got != UserAgent {
			t.Errorf("User-Agent = %q", got)
		}
		writeJSON(w, 200, wireFileJSON("f1", "READY"))
	}))
	if _, err := c.Get(context.Background(), "f1", GetOptions{}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(UserAgent, "ntropix-file-service-go/") {
		t.Errorf("UserAgent = %q", UserAgent)
	}
}

func TestCreateUpload_Retries429ButNot5xx(t *testing.T) {
	var calls atomic.Int32
	var status atomic.Int32
	status.Store(429)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if int(status.Load()) == 429 && n < 2 {
			apiError(w, 429, "rate_limited", "despacio")
			return
		}
		if status.Load() == 503 {
			apiError(w, 503, "unavailable", "caído")
			return
		}
		writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING", "upload": map[string]any{"mode": "simple", "url": "http://s/put"}})
	}))
	in := CreateUploadInput{Name: "a.txt", MimeType: "text/plain", Size: 1}
	if _, err := c.CreateUpload(context.Background(), in); err != nil {
		t.Fatalf("429 debería reintentarse: %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("llamadas tras 429 = %d", calls.Load())
	}
	calls.Store(0)
	status.Store(503)
	if _, err := c.CreateUpload(context.Background(), in); err == nil {
		t.Fatal("503 debería fallar")
	}
	if calls.Load() != 1 {
		t.Errorf("un 5xx no debe reintentarse al crear: llamadas = %d", calls.Load())
	}
}

func TestRetryAfter_CappedAt60s(t *testing.T) {
	h := http.Header{"Retry-After": {"3600"}}
	if got := retryAfter(h); got != maxRetryAfter || maxRetryAfter != 60*time.Second {
		t.Errorf("retryAfter = %s", got)
	}
}

func TestUsage(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/usage" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		writeJSON(w, 200, map[string]any{"used_bytes": 400, "quota_bytes": 1000, "file_count": 3,
			"max_file_size": 2048, "allowed_mime_types": []string{"image/*"}})
	}))
	u, err := c.Usage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if u.UsedBytes != 400 || u.QuotaBytes != 1000 || u.FileCount != 3 || u.MaxFileSize != 2048 ||
		len(u.AllowedMimeTypes) != 1 || u.AllowedMimeTypes[0] != "image/*" {
		t.Errorf("usage = %+v", u)
	}
}

func TestPurge(t *testing.T) {
	var method, path, actor string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, actor = r.Method, r.URL.Path, r.Header.Get("FS-Actor")
		if r.URL.Path == "/files/en-curso/purge" {
			apiError(w, 409, CodeInvalidState, "subida en curso")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	if err := c.Purge(WithActor(context.Background(), "user_1"), "f1"); err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/files/f1/purge" || actor != "user_1" {
		t.Errorf("request = %s %s actor=%q", method, path, actor)
	}
	var e *Error
	if err := c.Purge(context.Background(), "en-curso"); !errors.As(err, &e) || e.Status != 409 || e.Code != CodeInvalidState {
		t.Errorf("err = %v", err)
	}
}
