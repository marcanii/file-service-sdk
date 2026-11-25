//go:build e2e

// Tests end-to-end contra un stack real ya levantado:
//
//	FS_KEY=fsk_test_... FS_URL=http://localhost:8080 go test -tags e2e -run E2E -v
package fileservice

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

func e2eClient(t *testing.T) *Client {
	t.Helper()
	key := os.Getenv("FS_KEY")
	if key == "" {
		t.Skip("FS_KEY no definida")
	}
	base := os.Getenv("FS_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	c, err := New(Config{APIKey: key, BaseURL: base})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// browserPut emula el PUT del helper de navegador y devuelve el ETag.
func browserPut(t *testing.T, url string, body []byte, headers map[string]string) string {
	t.Helper()
	req, _ := http.NewRequest("PUT", url, bytes.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("PUT al storage → %d: %s", res.StatusCode, data)
	}
	return res.Header.Get("ETag")
}

// roundTripJSON pasa un valor por JSON, como lo vería el navegador.
func roundTripJSON(t *testing.T, v any, out any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestE2E_BrowserProtocolSimple(t *testing.T) {
	c := e2eClient(t)
	ctx := context.Background()
	content := randomBytes(t, 64<<10)
	owner := "go_e2e_user"
	opts := HandleOptions{OwnerRef: owner, Metadata: map[string]any{"sdk": "go"}}

	// create
	createBody, _ := json.Marshal(map[string]any{
		"action": "create", "name": "e2e-simple.bin", "mimeType": "application/octet-stream",
		"size": len(content), "metadata": map[string]any{"album": "x"},
	})
	res := c.HandleUpload(ctx, createBody, opts)
	if res.Status != 200 {
		t.Fatalf("create → %d %+v", res.Status, res.Body)
	}
	var created struct {
		ID     string `json:"id"`
		Token  string `json:"token"`
		Upload struct {
			Mode    string            `json:"mode"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"upload"`
	}
	roundTripJSON(t, res.Body, &created)
	if created.Upload.Mode != "simple" || created.Upload.URL == "" || created.Token == "" {
		t.Fatalf("create = %+v", created)
	}

	// PUT de bytes directo al storage
	browserPut(t, created.Upload.URL, content, created.Upload.Headers)

	// (b) complete con el token pero OTRO usuario → 403
	completeBody, _ := json.Marshal(map[string]any{"action": "complete", "id": created.ID, "token": created.Token})
	res = c.HandleUpload(ctx, completeBody, HandleOptions{OwnerRef: "otro_usuario"})
	if res.Status != 403 {
		t.Fatalf("complete de otro owner → %d %+v", res.Status, res.Body)
	}

	// complete del dueño → 200 AVAILABLE
	res = c.HandleUpload(ctx, completeBody, opts)
	if res.Status != 200 || res.File == nil || res.File.Status != StatusAvailable {
		t.Fatalf("complete → %d %+v", res.Status, res.Body)
	}
	var info map[string]any
	roundTripJSON(t, res.Body, &info)
	if info["ownerRef"] != owner || info["contentHash"] != sha256Hex(content) || info["download"] == nil {
		t.Errorf("FileInfo = %v", info)
	}
	meta, _ := info["metadata"].(map[string]any)
	if meta["album"] != "x" || meta["sdk"] != "go" {
		t.Errorf("metadata = %v", meta)
	}

	// (d) Get / List / Update / Delete / Restore sobre el mismo file
	t.Run("CRUD", func(t *testing.T) { crud(t, c, created.ID, owner) })
}

func crud(t *testing.T, c *Client, id, owner string) {
	ctx := WithActor(context.Background(), owner)

	f, err := c.Get(ctx, id, GetOptions{Inline: true})
	if err != nil || f.Status != StatusAvailable || f.Download == nil || f.Download.URL == "" {
		t.Fatalf("Get: %+v %v", f, err)
	}
	if _, err := c.DownloadURL(ctx, id, GetOptions{}); err != nil {
		t.Fatalf("DownloadURL: %v", err)
	}

	u, err := c.Usage(ctx)
	if err != nil || u.FileCount < 1 || u.UsedBytes < 1 || u.MaxFileSize < 1 || u.AllowedMimeTypes == nil {
		t.Fatalf("Usage: %+v %v", u, err)
	}

	files, _, err := c.List(ctx, ListOptions{OwnerRef: owner, Limit: 200})
	if err != nil || !containsID(files, id) {
		t.Fatalf("List: %d files, err %v", len(files), err)
	}
	found := false
	err = c.ListAll(ctx, ListOptions{OwnerRef: owner, Limit: 1}, func(f *File) error {
		if f.ID == id {
			found = true
			return io.EOF // corta la iteración
		}
		return nil
	})
	if err != io.EOF || !found {
		t.Fatalf("ListAll: found=%v err=%v", found, err)
	}

	f, err = c.Update(ctx, id, UpdateInput{Visibility: VisibilityPublic, Name: "renombrado.bin"})
	if err != nil || f.Visibility != VisibilityPublic || f.Name != "renombrado.bin" || f.PublicURL == "" {
		t.Fatalf("Update: %+v %v", f, err)
	}
	// La URL pública responde 302 sin credencial.
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := noRedirect.Get(f.PublicURL)
	if err != nil || res.StatusCode != http.StatusFound {
		t.Fatalf("URL pública: %v %v", res, err)
	}
	res.Body.Close()

	if err := c.Delete(ctx, id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	trashed, _, err := c.List(ctx, ListOptions{OwnerRef: owner, Trashed: true, Limit: 200})
	if err != nil || !containsID(trashed, id) {
		t.Fatalf("papelera: err %v", err)
	}
	if _, err := c.DownloadURL(ctx, id, GetOptions{}); err == nil {
		t.Fatal("un file en la papelera no debería tener descarga")
	}

	f, err = c.Restore(ctx, id)
	if err != nil || f.DeletedAt != nil {
		t.Fatalf("Restore: %+v %v", f, err)
	}
	if _, err := c.DownloadURL(ctx, id, GetOptions{}); err != nil {
		t.Fatalf("DownloadURL tras Restore: %v", err)
	}
}

func containsID(files []*File, id string) bool {
	for _, f := range files {
		if f.ID == id {
			return true
		}
	}
	return false
}

func TestE2E_BrowserProtocolMultipart(t *testing.T) {
	c := e2eClient(t)
	ctx := context.Background()
	content := randomBytes(t, 33<<20)
	opts := HandleOptions{OwnerRef: "go_e2e_user"}

	createBody, _ := json.Marshal(map[string]any{
		"action": "create", "name": "e2e-multi.bin", "mimeType": "application/octet-stream", "size": len(content),
	})
	res := c.HandleUpload(ctx, createBody, opts)
	if res.Status != 200 {
		t.Fatalf("create → %d %+v", res.Status, res.Body)
	}
	var created struct {
		ID     string `json:"id"`
		Token  string `json:"token"`
		Upload struct {
			Mode      string `json:"mode"`
			PartSize  int    `json:"partSize"`
			PartCount int    `json:"partCount"`
		} `json:"upload"`
	}
	roundTripJSON(t, res.Body, &created)
	if created.Upload.Mode != "multipart" || created.Upload.PartCount < 2 {
		t.Fatalf("create = %+v", created)
	}

	var parts []map[string]any
	for n := 1; n <= created.Upload.PartCount; n++ {
		partsBody, _ := json.Marshal(map[string]any{"action": "parts", "id": created.ID, "token": created.Token, "partNumbers": []int{n}})
		res := c.HandleUpload(ctx, partsBody, opts)
		if res.Status != 200 {
			t.Fatalf("parts → %d %+v", res.Status, res.Body)
		}
		var signed struct {
			URLs []struct {
				PartNumber int    `json:"partNumber"`
				URL        string `json:"url"`
			} `json:"urls"`
		}
		roundTripJSON(t, res.Body, &signed)
		start := (n - 1) * created.Upload.PartSize
		end := min(start+created.Upload.PartSize, len(content))
		etag := browserPut(t, signed.URLs[0].URL, content[start:end], nil)
		parts = append(parts, map[string]any{"partNumber": n, "etag": etag})
	}
	completeBody, _ := json.Marshal(map[string]any{"action": "complete", "id": created.ID, "token": created.Token, "parts": parts})
	res = c.HandleUpload(ctx, completeBody, HandleOptions{OwnerRef: "go_e2e_user", WaitTimeout: time.Minute})
	if res.Status != 200 || res.File == nil || res.File.Status != StatusAvailable || res.File.ContentHash != sha256Hex(content) {
		t.Fatalf("complete → %d %+v", res.Status, res.Body)
	}
}

func TestE2E_ServerUploadMultipart(t *testing.T) {
	c := e2eClient(t)
	ctx := context.Background()
	const size = 40 << 20

	// Reader secuencial (no ReaderAt): ejercita la lectura por partes sin cargar todo en memoria.
	h := sha256.New()
	body := io.TeeReader(io.LimitReader(rand.Reader, size), h)
	f, err := c.Upload(ctx, UploadInput{
		Name: "e2e-server.bin", MimeType: "application/octet-stream", Size: size, Body: body,
		OwnerRef: "go_e2e_server", Metadata: map[string]any{"sdk": "go"}, WaitTimeout: time.Minute,
	})
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if f.Status != StatusAvailable || f.Size != size || f.ContentHash != hex.EncodeToString(h.Sum(nil)) {
		t.Fatalf("file = %+v", f)
	}

	// Subida simple (< umbral) con un ReaderAt y el tamaño deducido del Body.
	small := randomBytes(t, 1<<20)
	f2, err := c.Upload(ctx, UploadInput{Name: "e2e-small.bin", MimeType: "application/octet-stream", Body: bytes.NewReader(small)})
	if err != nil || f2.Status != StatusAvailable || f2.ContentHash != sha256Hex(small) {
		t.Fatalf("Upload simple: %+v %v", f2, err)
	}
}

// Checksum declarado incorrecto: en simple lo rechaza el storage (checksum_mismatch); en multipart,
// la verificación del servicio (FAILED → *RejectedError).
func TestE2E_DeclaredChecksumIncorrecto(t *testing.T) {
	c := e2eClient(t)
	ctx := context.Background()
	wrong := sha256Hex([]byte("otro contenido"))

	_, err := c.Upload(ctx, UploadInput{Name: "e2e-mal.txt", MimeType: "text/plain",
		Body: bytes.NewReader([]byte("hola checksum\n")), SHA256: wrong})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != CodeChecksumMismatch || apiErr.Status != 400 {
		t.Fatalf("simple: err = %v", err)
	}

	big := randomBytes(t, 33<<20)
	_, err = c.Upload(ctx, UploadInput{Name: "e2e-mal.bin", MimeType: "application/octet-stream",
		Body: bytes.NewReader(big), SHA256: wrong, WaitTimeout: 2 * time.Minute})
	var rejected *RejectedError
	if !errors.As(err, &rejected) || rejected.File.Status != StatusFailed {
		t.Fatalf("multipart: err = %v", err)
	}
}

// Purga anticipada: irreversible; un file purgado no existe más (get, restore y purge → not_found).
func TestE2E_Purge(t *testing.T) {
	c := e2eClient(t)
	ctx := context.Background()
	f, err := c.Upload(ctx, UploadInput{Name: "e2e-purgar.txt", MimeType: "text/plain", Body: bytes.NewReader(randomBytes(t, 64))})
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if err := c.Purge(WithActor(ctx, "go_e2e"), f.ID); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	checks := map[string]func() error{
		"Get":     func() error { _, err := c.Get(ctx, f.ID, GetOptions{}); return err },
		"Restore": func() error { _, err := c.Restore(ctx, f.ID); return err },
		"Purge":   func() error { return c.Purge(ctx, f.ID) },
	}
	for name, call := range checks {
		var e *Error
		if err := call(); !errors.As(err, &e) || e.Code != CodeNotFound {
			t.Errorf("%s tras purgar: err = %v, quiero not_found", name, err)
		}
	}
}
