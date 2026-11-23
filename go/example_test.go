package fileservice_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	fileservice "github.com/marcanii/file-service-sdk/go"
)

func ExampleNew() {
	fs, err := fileservice.New(fileservice.Config{
		APIKey:  os.Getenv("FILE_SERVICE_KEY"), // fsk_live_... — solo en el backend
		BaseURL: "https://files.ntropix.dev",
		Timeout: 10 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}
	_ = fs
}

// El endpoint de subida para el helper de navegador, montado en net/http. auth identifica al
// usuario con el mecanismo propio del backend (sesión, JWT…).
func ExampleClient_UploadHandler() {
	fs, _ := fileservice.New(fileservice.Config{APIKey: os.Getenv("FILE_SERVICE_KEY"), BaseURL: "https://files.ntropix.dev"})

	auth := func(r *http.Request) (string, error) {
		c, err := r.Cookie("session")
		if err != nil {
			return "", err // → 401
		}
		return lookupUserID(c.Value)
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/files", fs.UploadHandler(auth, fileservice.HandleOptions{
		Metadata: map[string]any{"origen": "web"},
	}))
	_ = http.ListenAndServe(":3000", mux)
}

// HandleUpload sirve para frameworks que no aceptan un http.Handler directo, o para decidir el
// ownerRef con lógica propia.
func ExampleClient_HandleUpload() {
	fs, _ := fileservice.New(fileservice.Config{APIKey: os.Getenv("FILE_SERVICE_KEY"), BaseURL: "https://files.ntropix.dev"})

	handler := func(w http.ResponseWriter, r *http.Request) {
		userID, err := lookupUserIDFromRequest(r)
		if err != nil {
			http.Error(w, `{"error":{"code":"unauthorized","message":"sin sesión"}}`, http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		res := fs.HandleUpload(r.Context(), body, fileservice.HandleOptions{OwnerRef: userID})
		if res.File != nil && res.File.Status == fileservice.StatusAvailable {
			log.Printf("subida terminada: %s (%d bytes)", res.File.ID, res.File.Size)
		}
		writeJSON(w, res.Status, res.Body)
	}
	_ = handler
}

func ExampleClient_Upload() {
	fs, _ := fileservice.New(fileservice.Config{APIKey: os.Getenv("FILE_SERVICE_KEY"), BaseURL: "https://files.ntropix.dev"})
	ctx := context.Background()

	f, err := os.Open("informe.pdf")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	// El tamaño se toma del archivo; multipart si supera el umbral del servicio.
	file, err := fs.Upload(ctx, fileservice.UploadInput{
		Name:     "informe.pdf",
		MimeType: "application/pdf",
		Body:     f,
		OwnerRef: "user_8812",
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(file.ID, file.Status)
}

func ExampleClient_DownloadURL() {
	fs, _ := fileservice.New(fileservice.Config{APIKey: os.Getenv("FILE_SERVICE_KEY"), BaseURL: "https://files.ntropix.dev"})
	ctx := fileservice.WithActor(context.Background(), "user_8812") // queda en la auditoría

	url, err := fs.DownloadURL(ctx, "0193a1c7-2f00-7000-8000-0000000000aa", fileservice.GetOptions{Inline: true})
	var apiErr *fileservice.Error
	switch {
	case errors.As(err, &apiErr) && apiErr.Code == fileservice.CodeNotFound:
		fmt.Println("no existe")
	case err != nil:
		log.Fatal(err)
	default:
		fmt.Println("redirigir a", url)
	}
}

func ExampleClient_ListAll() {
	fs, _ := fileservice.New(fileservice.Config{APIKey: os.Getenv("FILE_SERVICE_KEY"), BaseURL: "https://files.ntropix.dev"})

	err := fs.ListAll(context.Background(), fileservice.ListOptions{OwnerRef: "user_8812"}, func(f *fileservice.File) error {
		fmt.Println(f.ID, f.Name, f.Size)
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
}

func ExampleVerifyWebhook() {
	secret := os.Getenv("FILE_SERVICE_WEBHOOK_SECRET") // whsec_...

	http.HandleFunc("POST /webhooks/files", func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // body CRUDO
		ev, err := fileservice.VerifyWebhook(payload, r.Header.Get(fileservice.SignatureHeader), secret, 0)
		if errors.Is(err, fileservice.ErrInvalidSignature) {
			http.Error(w, "firma inválida", http.StatusBadRequest)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// La entrega es at-least-once: descartar duplicados por ev.ID.
		switch ev.Type {
		case fileservice.EventFileAvailable:
			log.Printf("disponible: %s", ev.File.ID)
		case fileservice.EventFileQuarantined, fileservice.EventFileFailed:
			log.Printf("rechazado: %s (%s)", ev.File.ID, ev.File.Status)
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// ─── Helpers de los ejemplos ───

func lookupUserID(session string) (string, error) { return "user_" + session, nil }

func lookupUserIDFromRequest(r *http.Request) (string, error) {
	return lookupUserID(r.Header.Get("X-Session"))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
