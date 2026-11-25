package fileservice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"
)

// vectors son los vectores compartidos por todos los SDKs (../testdata/vectors.json).
type vectors struct {
	Webhook struct {
		Secret    string `json:"secret"`
		Timestamp int64  `json:"timestamp"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
		Expected  struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			FileID   string `json:"fileId"`
			FileName string `json:"fileName"`
			MimeType string `json:"mimeType"`
			Size     int64  `json:"size"`
		} `json:"expected"`
	} `json:"webhook"`
	WebhookFailed struct {
		Secret    string `json:"secret"`
		Timestamp int64  `json:"timestamp"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
		Expected  struct {
			Type   string `json:"type"`
			FileID string `json:"fileId"`
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"expected"`
	} `json:"webhookFailed"`
	WebhookNegative struct {
		Rejected []struct {
			Name      string `json:"name"`
			Signature string `json:"signature"`
			Now       int64  `json:"now"`
			Reason    string `json:"reason"`
		} `json:"rejected"`
		Accepted []struct {
			Name      string `json:"name"`
			Signature string `json:"signature"`
			Now       int64  `json:"now"`
		} `json:"accepted"`
	} `json:"webhookNegative"`
	UploadToken struct {
		APIKey string `json:"apiKey"`
		Cases  []struct {
			ID       string `json:"id"`
			OwnerRef string `json:"ownerRef"`
			Exp      int64  `json:"exp"`
			Token    string `json:"token"`
		} `json:"cases"`
		Negative []struct {
			Name     string `json:"name"`
			ID       string `json:"id"`
			OwnerRef string `json:"ownerRef"`
			Now      int64  `json:"now"`
			Token    string `json:"token"`
		} `json:"negative"`
	} `json:"uploadToken"`
	DeclaredChecksum struct {
		Content string `json:"content"`
		SHA256  string `json:"sha256"`
		Invalid []struct {
			Name  string          `json:"name"`
			Value json.RawMessage `json:"value"`
		} `json:"invalid"`
	} `json:"declaredChecksum"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile("../testdata/vectors.json")
	if err != nil {
		t.Fatalf("leyendo vectores: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parseando vectores: %v", err)
	}
	return v
}

// withClock fija el reloj de VerifyWebhook durante el test.
func withClock(t *testing.T, now time.Time) {
	t.Helper()
	prev := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = prev })
}

func TestWebhookVector_OK(t *testing.T) {
	v := loadVectors(t).Webhook
	withClock(t, time.Unix(v.Timestamp+10, 0))

	ev, err := VerifyWebhook([]byte(v.Payload), v.Signature, v.Secret, 0)
	if err != nil {
		t.Fatalf("VerifyWebhook: %v", err)
	}
	if ev.ID != v.Expected.ID || string(ev.Type) != v.Expected.Type {
		t.Errorf("evento = %s/%s, esperado %s/%s", ev.ID, ev.Type, v.Expected.ID, v.Expected.Type)
	}
	f := ev.File
	if f == nil || f.ID != v.Expected.FileID || f.Name != v.Expected.FileName ||
		f.MimeType != v.Expected.MimeType || f.Size != v.Expected.Size {
		t.Errorf("file = %+v, esperado %+v", f, v.Expected)
	}
	if f.OwnerRef != "user_1" || f.Status != StatusAvailable || f.Metadata == nil {
		t.Errorf("mapeo incompleto: %+v", f)
	}
}

func TestWebhookVector_Tampered(t *testing.T) {
	v := loadVectors(t).Webhook
	withClock(t, time.Unix(v.Timestamp, 0))

	tampered := []byte(v.Payload[:len(v.Payload)-2] + " }")
	_, err := VerifyWebhook(tampered, v.Signature, v.Secret, 0)
	if !errors.Is(err, ErrSignatureMismatch) || !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("err = %v, esperado ErrSignatureMismatch", err)
	}
	_, err = VerifyWebhook([]byte(v.Payload), v.Signature, "otro_secret", 0)
	if !errors.Is(err, ErrSignatureMismatch) {
		t.Fatalf("secret incorrecto: err = %v", err)
	}
}

func TestWebhookVector_Old(t *testing.T) {
	v := loadVectors(t).Webhook
	// Reloj real: el vector es de 2024, muy fuera de la tolerancia.
	_, err := VerifyWebhook([]byte(v.Payload), v.Signature, v.Secret, 0)
	if !errors.Is(err, ErrSignatureExpired) || !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("err = %v, esperado ErrSignatureExpired", err)
	}
	// Justo fuera de los 300 s.
	withClock(t, time.Unix(v.Timestamp+301, 0))
	if _, err := VerifyWebhook([]byte(v.Payload), v.Signature, v.Secret, 0); !errors.Is(err, ErrSignatureExpired) {
		t.Fatalf("301 s: err = %v", err)
	}
}

func TestWebhook_MalformedHeader(t *testing.T) {
	for _, sig := range []string{"", "garbage", "t=abc,v1=00", "t=1731250000", "t=1731250000,v1=zz"} {
		_, err := VerifyWebhook([]byte("{}"), sig, "s", 0)
		if !errors.Is(err, ErrInvalidSignature) {
			t.Errorf("firma %q: err = %v, esperado ErrInvalidSignature", sig, err)
		}
	}
}

func TestUploadTokenVectors(t *testing.T) {
	v := loadVectors(t).UploadToken
	for _, tc := range v.Cases {
		got := signUploadToken(v.APIKey, tc.ID, tc.OwnerRef, tc.Exp)
		if got != tc.Token {
			t.Errorf("token(%s, %s) = %s, esperado %s", tc.ID, tc.OwnerRef, got, tc.Token)
		}
		now := time.Unix(tc.Exp-60, 0)
		if !verifyUploadToken(v.APIKey, tc.Token, tc.ID, tc.OwnerRef, now) {
			t.Errorf("token vigente rechazado: %s", tc.Token)
		}
		if verifyUploadToken(v.APIKey, tc.Token, tc.ID, "otro_usuario", now) {
			t.Error("token aceptado con otro ownerRef")
		}
		if verifyUploadToken(v.APIKey, tc.Token, "0193a1c7-2f00-7000-8000-0000000000ff", tc.OwnerRef, now) {
			t.Error("token aceptado con otro id")
		}
		if verifyUploadToken(v.APIKey, tc.Token, tc.ID, tc.OwnerRef, time.Unix(tc.Exp, 0)) {
			t.Error("token aceptado con exp == now (vencido)")
		}
		if verifyUploadToken("fsk_test_otra", tc.Token, tc.ID, tc.OwnerRef, now) {
			t.Error("token aceptado con otra API key")
		}
	}
	for _, bad := range []string{"", "nodot", "abc.def", "1999999999.zz"} {
		if verifyUploadToken(v.APIKey, bad, "x", "y", time.Unix(0, 0)) {
			t.Errorf("token malformado aceptado: %q", bad)
		}
	}
}

func TestWebhookVector_FailedExponeReason(t *testing.T) {
	v := loadVectors(t).WebhookFailed
	withClock(t, time.Unix(v.Timestamp+10, 0))

	ev, err := VerifyWebhook([]byte(v.Payload), v.Signature, v.Secret, 0)
	if err != nil {
		t.Fatalf("VerifyWebhook: %v", err)
	}
	f := ev.File
	if string(ev.Type) != v.Expected.Type || f == nil || f.ID != v.Expected.FileID ||
		string(f.Status) != v.Expected.Status || f.Reason != v.Expected.Reason || f.PublicURL != "" {
		t.Errorf("evento = %+v, file = %+v; esperado %+v", ev, f, v.Expected)
	}
}

func TestUploadTokenVectors_Negative(t *testing.T) {
	v := loadVectors(t).UploadToken
	if len(v.Negative) == 0 {
		t.Fatal("sin vectores negativos")
	}
	for _, tc := range v.Negative {
		if verifyUploadToken(v.APIKey, tc.Token, tc.ID, tc.OwnerRef, time.Unix(tc.Now, 0)) {
			t.Errorf("%s: token aceptado: %q", tc.Name, tc.Token)
		}
	}
}

func TestWebhookVectors_Negative(t *testing.T) {
	all := loadVectors(t)
	w, n := all.Webhook, all.WebhookNegative
	if len(n.Rejected) == 0 || len(n.Accepted) == 0 {
		t.Fatal("sin vectores negativos")
	}
	want := map[string]error{
		"missing":   ErrMissingSignature,
		"malformed": ErrMalformedSignature,
		"mismatch":  ErrSignatureMismatch,
		"expired":   ErrSignatureExpired,
	}
	for _, tc := range n.Rejected {
		withClock(t, time.Unix(tc.Now, 0))
		_, err := VerifyWebhook([]byte(w.Payload), tc.Signature, w.Secret, 0)
		if !errors.Is(err, want[tc.Reason]) {
			t.Errorf("%s: err = %v, esperado %v", tc.Name, err, want[tc.Reason])
		}
	}
	for _, tc := range n.Accepted {
		withClock(t, time.Unix(tc.Now, 0))
		ev, err := VerifyWebhook([]byte(w.Payload), tc.Signature, w.Secret, 0)
		if err != nil || ev.ID != w.Expected.ID {
			t.Errorf("%s: ev = %+v, err = %v", tc.Name, ev, err)
		}
	}
}

// El sha256 de create (Checksum declarado) válido llega a POST /files; ausente o null no se manda.
func TestVectors_DeclaredChecksumPasaALaAPI(t *testing.T) {
	v := loadVectors(t)
	var bodies []map[string]any
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		writeJSON(w, 201, map[string]any{"id": "f1", "status": "PENDING",
			"upload": map[string]any{"mode": "simple", "url": "u", "headers": map[string]string{}, "expires_at": "2026-11-10T13:00:00Z"}})
	}))
	base := `{"action":"create","name":"a.txt","mimeType":"text/plain","size":18`
	for _, body := range []string{base + `,"sha256":"` + v.DeclaredChecksum.SHA256 + `"}`, base + `}`, base + `,"sha256":null}`} {
		if res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "u"}); res.Status != 200 {
			t.Fatalf("%s → %d %+v", body, res.Status, res.Body)
		}
	}
	if bodies[0]["sha256"] != v.DeclaredChecksum.SHA256 {
		t.Errorf("sha256 enviado = %v", bodies[0]["sha256"])
	}
	for _, b := range bodies[1:] {
		if _, ok := b["sha256"]; ok {
			t.Errorf("sin sha256 no debe mandarse: %v", b)
		}
	}
}

// Un sha256 inválido se rechaza con 400 validation sin llamar a la API.
func TestVectors_DeclaredChecksumInvalido(t *testing.T) {
	v := loadVectors(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("no debe llamar a la API: %s %s", r.Method, r.URL.Path)
	}))
	for _, tc := range v.DeclaredChecksum.Invalid {
		body := `{"action":"create","name":"a","mimeType":"x/y","size":1,"sha256":` + string(tc.Value) + `}`
		res := c.HandleUpload(context.Background(), []byte(body), HandleOptions{OwnerRef: "u"})
		if res.Status != 400 || errorOf(t, res).Code != CodeValidation {
			t.Errorf("%s → %d %+v", tc.Name, res.Status, res.Body)
		}
	}
}
