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
	var given [][]byte
	for _, field := range strings.Split(signature, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(field), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			if b, err := hex.DecodeString(v); err == nil {
				given = append(given, b)
			}
		}
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(given) == 0 {
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
