package fileservice

import (
	"errors"
	"fmt"
)

// Códigos de error estables. Son los `code` del contrato de la API más los que agrega el SDK
// (CodeNetwork, CodeTimeout, CodeStorageRejected).
const (
	CodeValidation      = "validation"
	CodeUnauthorized    = "unauthorized"
	CodeForbidden       = "forbidden"
	CodeProjectDisabled = "project_disabled"
	CodeNotFound        = "not_found"
	CodeInvalidState    = "invalid_state"
	CodeNoBytes         = "no_bytes"
	CodeTooLarge        = "too_large"
	CodeTypeNotAllowed  = "type_not_allowed"
	CodeQuotaExceeded   = "quota_exceeded"
	CodeStorageFull     = "storage_full"
	CodeRateLimited     = "rate_limited"
	CodeInternal        = "internal"
	// CodeQuarantined y CodeFailed son los de [RejectedError].
	CodeQuarantined = "quarantined"
	CodeFailed      = "failed"
	// CodeNetwork: no hubo respuesta del File Service (conexión rechazada, DNS, corte…).
	CodeNetwork = "network"
	// CodeTimeout: el File Service no respondió a tiempo, o la verificación no terminó a tiempo.
	CodeTimeout = "timeout"
	// CodeStorageRejected: el storage rechazó un PUT de bytes (URL vencida, tamaño distinto…).
	CodeStorageRejected = "storage_rejected"
)

// Error es un error devuelto por la API (o generado por el SDK al hablar con ella).
// Code es estable y sirve para decidir qué hacer; Message es para humanos.
type Error struct {
	// Status HTTP de la respuesta; 0 si no hubo respuesta (Code network o timeout).
	Status int
	// Code estable: ver las constantes Code*.
	Code string
	// Message legible, en español.
	Message string
	// RequestID es el X-Request-ID de la respuesta: incluilo al reportar un problema. Vacío si no
	// hubo respuesta del File Service (Code network o timeout).
	RequestID string
}

// Error implementa la interfaz error.
func (e *Error) Error() string {
	if e.RequestID != "" {
		return fmt.Sprintf("fileservice: %s (code=%s, status=%d, request_id=%s)", e.Message, e.Code, e.Status, e.RequestID)
	}
	return fmt.Sprintf("fileservice: %s (code=%s, status=%d)", e.Message, e.Code, e.Status)
}

// RejectedError indica que el archivo se subió pero el servicio lo rechazó al verificarlo: quedó
// en QUARANTINED (su tipo real no está permitido) o en FAILED (corrupto o incompleto).
//
// Equivale a un *Error con Status 422 y Code "quarantined" o "failed": errors.As(err, &apiErr)
// con apiErr *Error también lo encuentra.
type RejectedError struct {
	// File es el archivo rechazado, con su estado final.
	File *File
}

// Code devuelve CodeQuarantined o CodeFailed según el estado del archivo.
func (e *RejectedError) Code() string {
	if e.File != nil && e.File.Status == StatusQuarantined {
		return CodeQuarantined
	}
	return CodeFailed
}

// Error implementa la interfaz error.
func (e *RejectedError) Error() string {
	return "fileservice: " + e.message()
}

// Unwrap expone el equivalente *Error (422) para errors.As.
func (e *RejectedError) Unwrap() error {
	return &Error{Status: 422, Code: e.Code(), Message: e.message()}
}

func (e *RejectedError) message() string {
	if e.Code() == CodeQuarantined {
		mime := ""
		if e.File != nil {
			mime = e.File.MimeType
		}
		return fmt.Sprintf("el archivo quedó en cuarentena: su tipo real (%s) no está permitido", mime)
	}
	return "el archivo no pasó la verificación (corrupto o incompleto)"
}

// Errores de verificación de webhooks. Todos cumplen errors.Is(err, ErrInvalidSignature), así que
// alcanza con chequear ese para responder 400; las variantes sirven para loguear el motivo.
var (
	// ErrInvalidSignature es la raíz de todos los errores de firma de webhook.
	ErrInvalidSignature = errors.New("fileservice: firma de webhook inválida")
	// ErrMissingSignature: el header FS-Signature vino vacío.
	ErrMissingSignature = fmt.Errorf("%w: falta el header FS-Signature", ErrInvalidSignature)
	// ErrMalformedSignature: el header no tiene el formato t=<unix>,v1=<hex>.
	ErrMalformedSignature = fmt.Errorf("%w: FS-Signature con formato inválido", ErrInvalidSignature)
	// ErrSignatureMismatch: la firma no corresponde al body con ese secret.
	ErrSignatureMismatch = fmt.Errorf("%w: la firma no coincide", ErrInvalidSignature)
	// ErrSignatureExpired: el timestamp está fuera de la tolerancia (protege contra reenvíos).
	ErrSignatureExpired = fmt.Errorf("%w: el evento es demasiado viejo", ErrInvalidSignature)
)
