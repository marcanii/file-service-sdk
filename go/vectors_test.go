package fileservice

import (
	"encoding/json"
	"errors"
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
	UploadToken struct {
		APIKey string `json:"apiKey"`
		Cases  []struct {
			ID       string `json:"id"`
			OwnerRef string `json:"ownerRef"`
			Exp      int64  `json:"exp"`
			Token    string `json:"token"`
		} `json:"cases"`
	} `json:"uploadToken"`
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
