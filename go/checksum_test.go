package fileservice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Checksum declarado en Upload / CreateUpload (PROTOCOL.md).

// Con un Body releíble (io.ReaderAt: *bytes.Reader, *os.File…) el SDK calcula el SHA-256 y lo declara;
// el storage del fake lo verifica como el real.
func TestUpload_DeclaraElSHA256SiElBodyEsReleible(t *testing.T) {
	v := loadVectors(t)
	path := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(path, []byte(v.DeclaredChecksum.Content), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for name, body := range map[string]io.Reader{"bytes.Reader": strings.NewReader(v.DeclaredChecksum.Content), "os.File": file} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
			c := newTestClient(t, fake)
			if _, err := c.Upload(context.Background(), UploadInput{Name: "a.txt", MimeType: "text/plain", Body: body, NoWait: true}); err != nil {
				t.Fatal(err)
			}
			if fake.declared[0] != v.DeclaredChecksum.SHA256 {
				t.Errorf("sha256 declarado = %q", fake.declared[0])
			}
			if string(fake.received[0]) != v.DeclaredChecksum.Content {
				t.Errorf("recibido %q", fake.received[0])
			}
		})
	}
}

// Un Body de una sola pasada no se hashea (nunca se bufferiza para eso), salvo SHA256 explícito.
func TestUpload_StreamDeUnaPasadaSoloConSHA256Explicito(t *testing.T) {
	v := loadVectors(t)
	oneShot := func() io.Reader { return io.MultiReader(strings.NewReader(v.DeclaredChecksum.Content)) }
	size := int64(len(v.DeclaredChecksum.Content))
	for _, explicit := range []string{"", v.DeclaredChecksum.SHA256} {
		fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
		c := newTestClient(t, fake)
		if _, err := c.Upload(context.Background(), UploadInput{Name: "a", MimeType: "text/plain", Size: size, Body: oneShot(),
			SHA256: explicit, NoWait: true}); err != nil {
			t.Fatal(err)
		}
		if fake.declared[0] != explicit {
			t.Errorf("declarado = %q, quería %q", fake.declared[0], explicit)
		}
	}
}

// Un SHA256 explícito no se recalcula; si no coincide con el contenido, el storage rechaza el PUT
// simple y el SDK lo expone como checksum_mismatch.
func TestUpload_ChecksumMismatchEnSubidaSimple(t *testing.T) {
	fake := &fakeService{t: t, partSize: 5, threshold: 100, received: map[int][]byte{}}
	c := newTestClient(t, fake)
	_, err := c.Upload(context.Background(), UploadInput{Name: "a", MimeType: "text/plain",
		Body: bytes.NewReader([]byte("hola")), SHA256: strings.Repeat("0", 64), NoWait: true})
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeChecksumMismatch || e.Status != 400 {
		t.Fatalf("err = %v", err)
	}
	if fake.declared[0] != strings.Repeat("0", 64) {
		t.Errorf("el SHA256 explícito no debe recalcularse: %q", fake.declared[0])
	}
}

// Un SHA256 con otro formato falla con validation sin llamar a la API.
func TestUploadYCreateUpload_SHA256Invalido(t *testing.T) {
	v := loadVectors(t)
	c := newTestClient(t, &fakeService{t: t})
	c.baseURL = "http://127.0.0.1:1" // cualquier llamada fallaría con network
	for _, tc := range v.DeclaredChecksum.Invalid {
		var s string
		if err := json.Unmarshal(tc.Value, &s); err != nil || s == "" {
			continue // los no-string no existen en Go y "" es "sin Checksum declarado"
		}
		for name, call := range map[string]func() error{
			"CreateUpload": func() error {
				_, err := c.CreateUpload(context.Background(), CreateUploadInput{Name: "a", MimeType: "x/y", Size: 1, SHA256: s})
				return err
			},
			"Upload": func() error {
				_, err := c.Upload(context.Background(), UploadInput{Name: "a", MimeType: "x/y", Body: strings.NewReader("a"), SHA256: s})
				return err
			},
		} {
			var e *Error
			if err := call(); !errors.As(err, &e) || e.Code != CodeValidation {
				t.Errorf("%s %s: err = %v", name, tc.Name, err)
			}
		}
	}
}
