package fileservice

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "fsk_test_unit"

var fixedNow = time.Unix(1_800_000_000, 0)

// newTestClient arma un cliente contra un servidor httptest con reloj fijo y backoff corto.
func newTestClient(t *testing.T, h http.Handler) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(Config{APIKey: testKey, BaseURL: srv.URL + "/"})
	if err != nil {
		t.Fatal(err)
	}
	c.retryBase = time.Millisecond
	c.now = func() time.Time { return fixedNow }
	return c
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func wireFileJSON(id, status string) map[string]any {
	return map[string]any{
		"id": id, "project": "demo", "status": status, "original_name": "a.txt",
		"mime_type": "text/plain", "size_bytes": 3, "owner_ref": "user_1",
		"visibility": "private", "metadata": map[string]any{}, "created_at": "2026-11-10T12:00:00Z",
	}
}

// errorOf extrae el {"error":{code}} de un UploadResult.
func errorOf(t *testing.T, res UploadResult) errorDetail {
	t.Helper()
	b, ok := res.Body.(errorBody)
	if !ok {
		t.Fatalf("Body = %#v, se esperaba un error", res.Body)
	}
	return b.Error
}

func TestHandleUpload_UnknownAction(t *testing.T) {
	c := newTestClient(t, http.NotFoundHandler())
	for _, body := range []string{`{"action":"borrar"}`, `{}`, `null`} {
		res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "u"})
		if res.Status != 400 || errorOf(t, res).Code != CodeValidation {
			t.Errorf("%s → %d %+v", body, res.Status, res.Body)
		}
	}
	res := c.HandleUpload(context.Background(), []byte(`{nope`), HandleOptions{OwnerRef: "u"})
	if res.Status != 400 || errorOf(t, res).Code != CodeValidation {
		t.Errorf("JSON inválido → %d", res.Status)
	}
}

func TestHandleUpload_CreateReturnsToken(t *testing.T) {
	var got map[string]any
	var actor string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/files" {
			t.Errorf("request inesperado %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Error("falta la API key")
		}
		actor = r.Header.Get("FS-Actor")
		_ = json.NewDecoder(r.Body).Decode(&got)
		writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING", "upload": map[string]any{
			"mode": "simple", "url": "http://storage/put", "headers": map[string]string{"Content-Type": "text/plain"},
			"expires_at": "2026-11-10T12:15:00Z",
		}})
	}))

	body := `{"action":"create","name":"a.txt","mimeType":"text/plain","size":3,"metadata":{"album":"x","tenant":"hack"}}`
	res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{
		OwnerRef: "user_1", Visibility: VisibilityPublic, Metadata: map[string]any{"tenant": "t1"},
	})
	if res.Status != 200 {
		t.Fatalf("status %d: %+v", res.Status, res.Body)
	}
	cr := res.Body.(createResponse)
	if cr.ID != "f1" || cr.Upload.Mode != ModeSimple || cr.Upload.URL != "http://storage/put" ||
		cr.Upload.Headers["Content-Type"] != "text/plain" {
		t.Errorf("respuesta = %+v", cr)
	}
	if !verifyUploadToken(testKey, cr.Token, "f1", "user_1", fixedNow) {
		t.Errorf("token inválido: %s", cr.Token)
	}
	if !strings.HasPrefix(cr.Token, "1800086400.") {
		t.Errorf("exp del token debería ser now+86400: %s", cr.Token)
	}
	if got["owner_ref"] != "user_1" || got["visibility"] != "public" || got["original_name"] != "a.txt" ||
		got["mime_type"] != "text/plain" || got["size_bytes"] != float64(3) {
		t.Errorf("body enviado a la API = %v", got)
	}
	meta := got["metadata"].(map[string]any)
	if meta["album"] != "x" || meta["tenant"] != "t1" {
		t.Errorf("metadata = %v (debería ganar la del backend)", meta)
	}
	if actor != "user_1" {
		t.Errorf("FS-Actor = %q, esperado el ownerRef", actor)
	}

	// Serialización camelCase hacia el navegador.
	raw, _ := json.Marshal(res.Body)
	for _, k := range []string{`"token"`, `"upload"`, `"expiresAt"`, `"mode":"simple"`} {
		if !strings.Contains(string(raw), k) {
			t.Errorf("JSON %s no contiene %s", raw, k)
		}
	}
}

func TestHandleUpload_PropagatesAPIError(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		apiError(w, 413, "too_large", "supera el máximo del Proyecto")
	}))
	res := c.HandleUpload(context.Background(), []byte(`{"action":"create","name":"a","mimeType":"x/y","size":999999999999}`), HandleOptions{OwnerRef: "u"})
	e := errorOf(t, res)
	if res.Status != 413 || e.Code != "too_large" || e.Message != "supera el máximo del Proyecto" {
		t.Errorf("→ %d %+v", res.Status, e)
	}
	if calls.Load() != 1 {
		t.Errorf("create se llamó %d veces (no debe reintentarse)", calls.Load())
	}
}

func TestHandleUpload_EmptyOwnerRefIs401(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	res := c.HandleUpload(context.Background(), []byte(`{"action":"create","name":"a","mimeType":"x/y","size":1}`), HandleOptions{})
	if res.Status != 401 || errorOf(t, res).Code != CodeUnauthorized || calls.Load() != 0 {
		t.Errorf("→ %d %+v (llamadas %d)", res.Status, res.Body, calls.Load())
	}
}

func TestHandleUpload_APIKeyRejectedIs502(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
	}{{401, "unauthorized"}, {403, "forbidden"}, {403, "project_disabled"}} {
		c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			apiError(w, tc.status, tc.code, "key rechazada")
		}))
		res := c.HandleUpload(context.Background(), []byte(`{"action":"create","name":"a","mimeType":"x/y","size":1}`), HandleOptions{OwnerRef: "u"})
		if res.Status != 502 || errorOf(t, res).Code != tc.code {
			t.Errorf("API %d %s → %d %+v, esperado 502 con el mismo code", tc.status, tc.code, res.Status, res.Body)
		}
	}
}

func TestHandleUpload_CreateNotRetriedOn503(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		apiError(w, 503, "internal", "caído")
	}))
	res := c.HandleUpload(context.Background(), []byte(`{"action":"create","name":"a","mimeType":"x/y","size":1}`), HandleOptions{OwnerRef: "u"})
	if res.Status != 503 || calls.Load() != 1 {
		t.Errorf("status %d, llamadas %d", res.Status, calls.Load())
	}
}

func TestHandleUpload_PartsRetriesOn503(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/files/f1/parts" {
			t.Errorf("path %s", r.URL.Path)
		}
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			apiError(w, 503, "internal", "temporal")
			return
		}
		var req struct {
			PartNumbers []int `json:"part_numbers"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		urls := []map[string]any{}
		for _, n := range req.PartNumbers {
			urls = append(urls, map[string]any{"part_number": n, "url": "http://storage/p"})
		}
		writeJSON(w, 200, map[string]any{"urls": urls, "expires_at": "2026-11-10T12:15:00Z"})
	}))
	token := signUploadToken(testKey, "f1", "u", fixedNow.Add(time.Hour).Unix())
	body := `{"action":"parts","id":"f1","token":"` + token + `","partNumbers":[1,2]}`
	res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "u"})
	if res.Status != 200 {
		t.Fatalf("status %d %+v", res.Status, res.Body)
	}
	pr := res.Body.(partsResponse)
	if len(pr.URLs) != 2 || pr.URLs[1].PartNumber != 2 {
		t.Errorf("urls = %+v", pr.URLs)
	}
	if calls.Load() != 2 {
		t.Errorf("llamadas = %d, esperado 2 (un reintento)", calls.Load())
	}
	raw, _ := json.Marshal(res.Body)
	if !strings.Contains(string(raw), `"partNumber":1`) {
		t.Errorf("JSON = %s", raw)
	}
}

func TestHandleUpload_TokenChecks(t *testing.T) {
	var calls atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 200, wireFileJSON("f1", "AVAILABLE"))
	}))
	valid := signUploadToken(testKey, "f1", "user_1", fixedNow.Add(time.Hour).Unix())
	expired := signUploadToken(testKey, "f1", "user_1", fixedNow.Add(-time.Second).Unix())
	cases := []struct {
		name, body, owner string
		status            int
	}{
		{"otro owner", `{"action":"complete","id":"f1","token":"` + valid + `"}`, "user_2", 403},
		{"vencido", `{"action":"complete","id":"f1","token":"` + expired + `"}`, "user_1", 403},
		{"sin token", `{"action":"complete","id":"f1"}`, "user_1", 403},
		{"otro id", `{"action":"parts","id":"f2","token":"` + valid + `","partNumbers":[1]}`, "user_1", 403},
		{"sin id", `{"action":"complete","token":"` + valid + `"}`, "user_1", 400},
	}
	for _, tc := range cases {
		res := c.HandleUpload(context.Background(), []byte(tc.body), HandleOptions{OwnerRef: tc.owner})
		if res.Status != tc.status {
			t.Errorf("%s: status %d, esperado %d", tc.name, res.Status, tc.status)
		}
	}
	if calls.Load() != 0 {
		t.Errorf("la API no debió llamarse con token inválido (%d llamadas)", calls.Load())
	}
}

func TestHandleUpload_CompleteWaitsAndRejects(t *testing.T) {
	final := "AVAILABLE"
	var gets atomic.Int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/files/f1/complete":
			var req struct {
				Parts []struct {
					PartNumber int    `json:"part_number"`
					ETag       string `json:"etag"`
				} `json:"parts"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			if len(req.Parts) != 1 || req.Parts[0].ETag != "abc" {
				t.Errorf("parts = %+v", req.Parts)
			}
			writeJSON(w, 200, wireFileJSON("f1", "READY"))
		case r.Method == "GET" && r.URL.Path == "/files/f1":
			if gets.Add(1) == 1 {
				writeJSON(w, 200, wireFileJSON("f1", "READY"))
				return
			}
			writeJSON(w, 200, wireFileJSON("f1", final))
		default:
			t.Errorf("request inesperado %s %s", r.Method, r.URL.Path)
		}
	}))
	token := signUploadToken(testKey, "f1", "user_1", fixedNow.Add(time.Hour).Unix())
	body := `{"action":"complete","id":"f1","token":"` + token + `","parts":[{"partNumber":1,"etag":"\"abc\""}]}`

	res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "user_1"})
	if res.Status != 200 || res.File == nil || res.File.Status != StatusAvailable {
		t.Fatalf("→ %d %+v", res.Status, res.Body)
	}
	raw, _ := json.Marshal(res.Body)
	for _, k := range []string{`"name":"a.txt"`, `"mimeType":"text/plain"`, `"ownerRef":"user_1"`, `"createdAt"`} {
		if !strings.Contains(string(raw), k) {
			t.Errorf("FileInfo %s no contiene %s", raw, k)
		}
	}

	final = "QUARANTINED"
	gets.Store(0)
	res = c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "user_1"})
	if res.Status != 422 || errorOf(t, res).Code != CodeQuarantined {
		t.Errorf("cuarentena → %d %+v", res.Status, res.Body)
	}
	if res.File == nil || res.File.Status != StatusQuarantined {
		t.Errorf("el 422 debería exponer el file rechazado en File: %+v", res.File)
	}
}

func TestHandleUpload_CompleteWaitTimeoutReturnsReady(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, wireFileJSON("f1", "READY"))
	}))
	token := signUploadToken(testKey, "f1", "u", fixedNow.Add(time.Hour).Unix())
	res := c.HandleUpload(context.Background(), []byte(`{"action":"complete","id":"f1","token":"`+token+`"}`),
		HandleOptions{OwnerRef: "u", WaitTimeout: 100 * time.Millisecond})
	if res.Status != 200 || res.File == nil || res.File.Status != StatusReady {
		t.Errorf("→ %d %+v", res.Status, res.Body)
	}
}

func TestHandleUpload_NetworkErrorIs502(t *testing.T) {
	c, _ := New(Config{APIKey: testKey, BaseURL: "http://127.0.0.1:1", Retries: -1})
	res := c.HandleUpload(context.Background(), []byte(`{"action":"create","name":"a","mimeType":"x/y","size":1}`), HandleOptions{OwnerRef: "u"})
	if res.Status != 502 || errorOf(t, res).Code != CodeNetwork {
		t.Errorf("→ %d %+v", res.Status, res.Body)
	}
}

func TestUploadHandler(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING", "upload": map[string]any{
			"mode": "multipart", "part_size": 8388608, "part_count": 5, "expires_at": "2026-11-10T12:15:00Z",
		}})
	}))
	h := c.UploadHandler(func(r *http.Request) (string, error) {
		if u := r.Header.Get("X-User"); u != "" {
			return u, nil
		}
		return "", errors.New("sin sesión")
	}, HandleOptions{})

	do := func(method, user, body string) (*http.Response, map[string]any) {
		req := httptest.NewRequest(method, "/api/files", strings.NewReader(body))
		if user != "" {
			req.Header.Set("X-User", user)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		res := rec.Result()
		var out map[string]any
		data, _ := io.ReadAll(res.Body)
		_ = json.Unmarshal(data, &out)
		return res, out
	}

	res, out := do("POST", "", `{"action":"create"}`)
	if res.StatusCode != 401 || out["error"].(map[string]any)["code"] != CodeUnauthorized {
		t.Errorf("sin auth → %d %v", res.StatusCode, out)
	}
	h2 := c.UploadHandler(func(*http.Request) (string, error) { return "", nil }, HandleOptions{})
	rec := httptest.NewRecorder()
	h2.ServeHTTP(rec, httptest.NewRequest("POST", "/api/files", strings.NewReader(`{"action":"create"}`)))
	if rec.Code != 401 {
		t.Errorf("ownerRef vacío → %d", rec.Code)
	}
	res, _ = do("GET", "u", "")
	if res.StatusCode != 405 {
		t.Errorf("GET → %d", res.StatusCode)
	}
	res, out = do("POST", "user_9", `{"action":"create","name":"v.bin","mimeType":"application/octet-stream","size":40000000}`)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("create → %d %v", res.StatusCode, out)
	}
	up := out["upload"].(map[string]any)
	if up["mode"] != "multipart" || up["partSize"] != float64(8388608) || up["partCount"] != float64(5) {
		t.Errorf("upload = %v", up)
	}
	if !verifyUploadToken(testKey, out["token"].(string), "f1", "user_9", fixedNow) {
		t.Error("el token no está atado al ownerRef de auth")
	}
}
