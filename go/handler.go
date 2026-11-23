package fileservice

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// uploadTokenTTL es la vigencia del token de subida (igual a ABANDONED_UPLOAD_TIMEOUT del servicio).
const uploadTokenTTL = 24 * time.Hour

// maxHandlerBody acota el body JSON que acepta UploadHandler.
const maxHandlerBody = 1 << 20

// HandleOptions configura el endpoint de subida ([Client.HandleUpload], [Client.UploadHandler]).
type HandleOptions struct {
	// OwnerRef es el id del Usuario final autenticado por TU backend (obligatorio: vacío → 401).
	// Se fija en el archivo y ata el token de subida a ese usuario. En UploadHandler lo completa la
	// función auth.
	OwnerRef string
	// Visibility fija la visibilidad de los archivos creados (default: private).
	Visibility Visibility
	// Metadata propia del backend. Se combina con la que manda el navegador; ante la misma clave
	// gana la del backend.
	Metadata map[string]any
	// WaitTimeout es cuánto espera la acción complete a que termine la verificación (default 30 s).
	// Si vence, responde 200 con el archivo en READY (el webhook avisa al terminar).
	WaitTimeout time.Duration
}

// UploadResult es la respuesta HTTP que el endpoint de subida debe devolver al navegador:
// serializá Body como JSON con el código Status.
type UploadResult struct {
	// Status HTTP a responder.
	Status int
	// Body a serializar como JSON: la respuesta de la acción o {"error":{"code","message"}}.
	Body any
	// File es el archivo resultante de la acción complete, o el archivo rechazado en un 422
	// (que no viaja en Body). nil en los demás casos.
	File *File
}

// handleRequest es el body que manda el helper de navegador.
type handleRequest struct {
	Action      string         `json:"action"`
	Name        string         `json:"name"`
	MimeType    string         `json:"mimeType"`
	Size        int64          `json:"size"`
	Metadata    map[string]any `json:"metadata"`
	ID          string         `json:"id"`
	Token       string         `json:"token"`
	PartNumbers []int          `json:"partNumbers"`
	Parts       []Part         `json:"parts"`
}

type createResponse struct {
	ID     string             `json:"id"`
	Token  string             `json:"token"`
	Upload UploadInstructions `json:"upload"`
}

type partsResponse struct {
	URLs []PartURL `json:"urls"`
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// HandleUpload implementa el endpoint de subida del protocolo del navegador
// (acciones create, parts y complete; ver PROTOCOL.md). body es el body crudo del request y
// opts.OwnerRef el usuario que TU backend autenticó.
//
// Nunca devuelve error ni entra en pánico: todo se traduce a un UploadResult con el status y el
// cuerpo {"error":{"code","message"}} del protocolo:
//
//   - OwnerRef vacío → 401 unauthorized.
//   - Token inválido, vencido o de otro usuario → 403 forbidden.
//   - Archivo rechazado por la verificación → 422 quarantined/failed (el file va en
//     UploadResult.File, no en el Body).
//   - La API rechazó la API key del backend (401/403: unauthorized, forbidden, project_disabled) o
//     no respondió (network, timeout) → 502 con el code original: es un problema del servidor,
//     no del usuario.
//   - Los demás errores de la API se propagan tal cual (too_large, type_not_allowed…).
//
// Si ctx no trae actor ([WithActor]), se usa OwnerRef.
func (c *Client) HandleUpload(ctx context.Context, body []byte, opts HandleOptions) (res UploadResult) {
	defer func() {
		if r := recover(); r != nil {
			res = errorResult(http.StatusInternalServerError, CodeInternal, "error interno")
		}
	}()
	if opts.OwnerRef == "" {
		return errorResult(http.StatusUnauthorized, CodeUnauthorized, "no se pudo identificar al usuario")
	}
	var req handleRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return errorResult(http.StatusBadRequest, CodeValidation, "body JSON inválido: "+err.Error())
	}
	if actorFrom(ctx) == "" {
		ctx = WithActor(ctx, opts.OwnerRef)
	}
	switch req.Action {
	case "create":
		return c.handleCreate(ctx, req, opts)
	case "parts":
		return c.handleParts(ctx, req, opts)
	case "complete":
		return c.handleComplete(ctx, req, opts)
	default:
		return errorResult(http.StatusBadRequest, CodeValidation, fmt.Sprintf("action desconocida: %q", req.Action))
	}
}

func (c *Client) handleCreate(ctx context.Context, req handleRequest, opts HandleOptions) UploadResult {
	created, err := c.CreateUpload(ctx, CreateUploadInput{
		Name:       req.Name,
		MimeType:   req.MimeType,
		Size:       req.Size,
		OwnerRef:   opts.OwnerRef,
		Visibility: opts.Visibility,
		Metadata:   mergeMetadata(req.Metadata, opts.Metadata),
	})
	if err != nil {
		return errorFromErr(err)
	}
	exp := c.now().Add(uploadTokenTTL).Unix()
	return UploadResult{Status: http.StatusOK, Body: createResponse{
		ID:     created.ID,
		Token:  signUploadToken(c.apiKey, created.ID, opts.OwnerRef, exp),
		Upload: created.Upload,
	}}
}

func (c *Client) handleParts(ctx context.Context, req handleRequest, opts HandleOptions) UploadResult {
	if res, ok := c.checkToken(req, opts); !ok {
		return res
	}
	if len(req.PartNumbers) == 0 || len(req.PartNumbers) > maxPartsPerBatch {
		return errorResult(http.StatusBadRequest, CodeValidation,
			fmt.Sprintf("partNumbers debe tener entre 1 y %d partes", maxPartsPerBatch))
	}
	urls, err := c.SignParts(ctx, req.ID, req.PartNumbers)
	if err != nil {
		return errorFromErr(err)
	}
	return UploadResult{Status: http.StatusOK, Body: partsResponse{URLs: urls}}
}

func (c *Client) handleComplete(ctx context.Context, req handleRequest, opts HandleOptions) UploadResult {
	if res, ok := c.checkToken(req, opts); !ok {
		return res
	}
	if _, err := c.Complete(ctx, req.ID, CompleteOptions{Parts: req.Parts}); err != nil {
		return errorFromErr(err)
	}
	file, timedOut, err := c.wait(ctx, req.ID, WaitOptions{Timeout: opts.WaitTimeout})
	if err != nil && !timedOut {
		return errorFromErr(err)
	}
	// Si la espera venció, el file sigue en READY: se devuelve igual y el webhook avisa al terminar.
	return UploadResult{Status: http.StatusOK, Body: file, File: file}
}

// checkToken valida que el id y el token vengan y que el token sea de este usuario.
func (c *Client) checkToken(req handleRequest, opts HandleOptions) (UploadResult, bool) {
	if req.ID == "" {
		return errorResult(http.StatusBadRequest, CodeValidation, "falta id"), false
	}
	if !verifyUploadToken(c.apiKey, req.Token, req.ID, opts.OwnerRef, c.now()) {
		return errorResult(http.StatusForbidden, CodeForbidden, "token de subida inválido, vencido o de otro usuario"), false
	}
	return UploadResult{}, true
}

// UploadHandler devuelve un http.Handler con el endpoint de subida, listo para montar en
// net/http, chi, gin (gin.WrapH), echo (echo.WrapHandler)…
//
// auth identifica al usuario del request con el mecanismo de TU backend (sesión, JWT…) y devuelve
// su ownerRef; si devuelve error o un ownerRef vacío, el handler responde 401 unauthorized.
// auth no puede ser nil.
func (c *Client) UploadHandler(auth func(*http.Request) (ownerRef string, err error), opts HandleOptions) http.Handler {
	if auth == nil {
		panic("fileservice: UploadHandler requiere una función auth")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeResult(w, errorResult(http.StatusMethodNotAllowed, "method_not_allowed", "solo se acepta POST"))
			return
		}
		ownerRef, err := auth(r)
		if err != nil {
			writeResult(w, errorResult(http.StatusUnauthorized, CodeUnauthorized, "no se pudo identificar al usuario"))
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxHandlerBody))
		if err != nil {
			writeResult(w, errorResult(http.StatusBadRequest, CodeValidation, "no se pudo leer el body: "+err.Error()))
			return
		}
		o := opts
		o.OwnerRef = ownerRef
		writeResult(w, c.HandleUpload(r.Context(), body, o))
	})
}

func writeResult(w http.ResponseWriter, res UploadResult) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(res.Status)
	_ = json.NewEncoder(w).Encode(res.Body)
}

func errorResult(status int, code, message string) UploadResult {
	return UploadResult{Status: status, Body: errorBody{Error: errorDetail{Code: code, Message: message}}}
}

// errorFromErr traduce un error del cliente a la respuesta del protocolo.
func errorFromErr(err error) UploadResult {
	var rejected *RejectedError
	if errors.As(err, &rejected) {
		// El file rechazado queda para el backend; al navegador solo va el error.
		res := errorResult(http.StatusUnprocessableEntity, rejected.Code(), rejected.message())
		res.File = rejected.File
		return res
	}
	var apiErr *Error
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case 0, http.StatusUnauthorized, http.StatusForbidden:
			// Sin respuesta del File Service, o la API key del backend fue rechazada: es un problema
			// del servidor, nunca un 401/403 para el navegador.
			return errorResult(http.StatusBadGateway, apiErr.Code, apiErr.Message)
		}
		return errorResult(apiErr.Status, apiErr.Code, apiErr.Message)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errorResult(http.StatusBadGateway, CodeTimeout, "se agotó el tiempo hablando con el File Service")
	}
	if errors.Is(err, context.Canceled) {
		return errorResult(http.StatusBadGateway, CodeNetwork, "request cancelado")
	}
	return errorResult(http.StatusInternalServerError, CodeInternal, "error interno")
}

// mergeMetadata combina la metadata del navegador con la del backend (gana el backend).
func mergeMetadata(client, server map[string]any) map[string]any {
	if len(client) == 0 && len(server) == 0 {
		return nil
	}
	out := make(map[string]any, len(client)+len(server))
	for k, v := range client {
		out[k] = v
	}
	for k, v := range server {
		out[k] = v
	}
	return out
}

// ─── Token de subida ─────────────────────────────────────────────────────────
// token = "<exp>.<hex(HMAC-SHA256(apiKey, "fs-upload-token.v1:<id>:<ownerRef>:<exp>"))>"

func uploadTokenMAC(apiKey, id, ownerRef string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(apiKey))
	fmt.Fprintf(mac, "fs-upload-token.v1:%s:%s:%d", id, ownerRef, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

func signUploadToken(apiKey, id, ownerRef string, exp int64) string {
	return strconv.FormatInt(exp, 10) + "." + uploadTokenMAC(apiKey, id, ownerRef, exp)
}

// verifyUploadToken comprueba vigencia (exp > now) y firma, en tiempo constante.
func verifyUploadToken(apiKey, token, id, ownerRef string, now time.Time) bool {
	expStr, sig, ok := strings.Cut(token, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || exp <= now.Unix() {
		return false
	}
	given, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	expected, _ := hex.DecodeString(uploadTokenMAC(apiKey, id, ownerRef, exp))
	return hmac.Equal(given, expected)
}
