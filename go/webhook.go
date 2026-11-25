package fileservice

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DefaultWebhookTolerance es la antigüedad máxima aceptada de un webhook.
const DefaultWebhookTolerance = 300 * time.Second

// SignatureHeader es el header con la firma de los webhooks.
const SignatureHeader = "FS-Signature"

// timeNow es el reloj de VerifyWebhook (reemplazable en tests).
var timeNow = time.Now

// VerifyWebhook verifica la firma de un webhook del File Service y devuelve el evento.
//
// payload es el body CRUDO tal como llegó (sin parsear ni re-serializar), signature el valor del
// header FS-Signature y secret el whsec_... del Proyecto. tolerance es la antigüedad máxima del
// evento (0 usa [DefaultWebhookTolerance]): protege contra reenvíos.
//
// Los errores de firma cumplen errors.Is(err, ErrInvalidSignature).
func VerifyWebhook(payload []byte, signature, secret string, tolerance time.Duration) (*WebhookEvent, error) {
	if tolerance <= 0 {
		tolerance = DefaultWebhookTolerance
	}
	if strings.TrimSpace(signature) == "" {
		return nil, ErrMissingSignature
	}
	var ts string
	var tSeen bool
	var given [][]byte
	for _, field := range strings.Split(signature, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(field), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			if tSeen {
				return nil, ErrMalformedSignature
			}
			tSeen, ts = true, v
		case "v1":
			if !isLowerHex(v, sha256.Size*2) {
				continue
			}
			b, err := hex.DecodeString(v)
			if err != nil {
				continue
			}
			given = append(given, b)
		}
	}
	if !isCanonicalUnix(ts) || len(given) == 0 {
		return nil, ErrMalformedSignature
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return nil, ErrMalformedSignature
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(payload)
	expected := mac.Sum(nil)
	match := false
	for _, g := range given {
		if hmac.Equal(g, expected) {
			match = true
		}
	}
	if !match {
		return nil, ErrSignatureMismatch
	}
	age := timeNow().Unix() - t
	if age < 0 {
		age = -age
	}
	if time.Duration(age)*time.Second > tolerance {
		return nil, ErrSignatureExpired
	}

	var raw struct {
		ID   string           `json:"id"`
		Type WebhookEventType `json:"type"`
		Data struct {
			File *wireFile `json:"file"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("fileservice: payload de webhook inválido: %w", err)
	}
	ev := &WebhookEvent{ID: raw.ID, Type: raw.Type}
	if raw.Data.File != nil {
		ev.File = raw.Data.File.toFile()
	}
	return ev, nil
}

// isCanonicalUnix reporta si s es un timestamp Unix canónico (sdk/PROTOCOL.md): 1 a 12 dígitos
// ASCII, sin signo, sin ceros a la izquierda ni espacios.
func isCanonicalUnix(s string) bool {
	if len(s) == 0 || len(s) > 12 || s[0] < '1' || s[0] > '9' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// isLowerHex reporta si s son exactamente n caracteres hex en minúscula.
func isLowerHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
