package fileservice

import "time"

// FileStatus es el estado del ciclo de vida de un archivo. Solo StatusAvailable es descargable.
type FileStatus string

// Estados posibles de un archivo.
const (
	StatusPending     FileStatus = "PENDING"
	StatusUploading   FileStatus = "UPLOADING"
	StatusReady       FileStatus = "READY"
	StatusAvailable   FileStatus = "AVAILABLE"
	StatusFailed      FileStatus = "FAILED"
	StatusQuarantined FileStatus = "QUARANTINED"
)

// Visibility define quién puede leer un archivo.
type Visibility string

// Visibilidades posibles. VisibilityPublic da una URL estable sin credencial (File.PublicURL).
const (
	VisibilityPrivate Visibility = "private"
	VisibilityPublic  Visibility = "public"
)

// UploadMode indica cómo se suben los bytes al storage.
type UploadMode string

// Modos de subida: simple (un PUT) para archivos chicos, multipart (partes) para grandes.
const (
	ModeSimple    UploadMode = "simple"
	ModeMultipart UploadMode = "multipart"
)

// WebhookEventType es el tipo de un evento de webhook.
type WebhookEventType string

// Eventos que envía el File Service.
const (
	EventFileAvailable   WebhookEventType = "file.available"
	EventFileFailed      WebhookEventType = "file.failed"
	EventFileQuarantined WebhookEventType = "file.quarantined"
)

// File es un archivo tal como lo ve el Proyecto. Los tags JSON (camelCase) son los del protocolo
// del navegador: se puede devolver tal cual a un frontend.
type File struct {
	ID string `json:"id"`
	// Project es el slug del Proyecto dueño.
	Project string     `json:"project"`
	Status  FileStatus `json:"status"`
	Name    string     `json:"name"`
	// MimeType es el tipo declarado al subir; una vez AVAILABLE, el tipo REAL detectado.
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	// ContentHash es el SHA-256 del contenido, cuando ya fue verificado.
	ContentHash string `json:"contentHash,omitempty"`
	// OwnerRef es el id del Usuario final en tu sistema, si se informó al subir.
	OwnerRef   string     `json:"ownerRef,omitempty"`
	Visibility Visibility `json:"visibility"`
	// PublicURL es la URL estable de un archivo público y disponible (usable en un <img src>).
	PublicURL string `json:"publicUrl,omitempty"`
	// Metadata son los datos propios del Proyecto. Nunca es nil.
	Metadata  map[string]any `json:"metadata"`
	CreatedAt time.Time      `json:"createdAt"`
	// DeletedAt está presente si el archivo está en la papelera.
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	// Download es una URL firmada de vida corta. Solo viene en Get y si el archivo está disponible.
	Download *Download `json:"download,omitempty"`
}

// Download es una URL firmada de descarga.
type Download struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// UploadInstructions le dicen al navegador cómo subir los bytes directo al storage.
type UploadInstructions struct {
	Mode UploadMode `json:"mode"`
	// URL firmada para un único PUT (solo ModeSimple).
	URL string `json:"url,omitempty"`
	// Headers que el PUT debe llevar (solo ModeSimple).
	Headers map[string]string `json:"headers,omitempty"`
	// PartSize es el tamaño de cada parte; la última puede ser menor (solo ModeMultipart).
	PartSize int64 `json:"partSize,omitempty"`
	// PartCount es la cantidad de partes (solo ModeMultipart).
	PartCount int       `json:"partCount,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// CreatedUpload es el resultado de iniciar una subida.
type CreatedUpload struct {
	ID     string             `json:"id"`
	Status FileStatus         `json:"status"`
	Upload UploadInstructions `json:"upload"`
}

// Part es una parte ya subida en multipart: su número (desde 1) y el ETag que devolvió el storage.
type Part struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
}

// PartURL es la URL firmada para subir una parte con PUT.
type PartURL struct {
	PartNumber int    `json:"partNumber"`
	URL        string `json:"url"`
}

// WebhookEvent es un evento que el File Service envía al webhook del Proyecto.
type WebhookEvent struct {
	// ID único del evento: usalo para descartar duplicados (la entrega es at-least-once).
	ID   string           `json:"id"`
	Type WebhookEventType `json:"type"`
	// File es el archivo del evento (sin Download).
	File *File `json:"file"`
}

// ─── Formato del wire (snake_case de la API) ────────────────────────────────

type wireFile struct {
	ID          string         `json:"id"`
	Project     string         `json:"project"`
	Status      FileStatus     `json:"status"`
	Name        string         `json:"original_name"`
	MimeType    string         `json:"mime_type"`
	Size        int64          `json:"size_bytes"`
	ContentHash string         `json:"content_hash"`
	OwnerRef    string         `json:"owner_ref"`
	Visibility  Visibility     `json:"visibility"`
	PublicURL   string         `json:"public_url"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   time.Time      `json:"created_at"`
	DeletedAt   *time.Time     `json:"deleted_at"`
	Download    *struct {
		URL       string    `json:"url"`
		ExpiresAt time.Time `json:"expires_at"`
	} `json:"download"`
}

func (w *wireFile) toFile() *File {
	f := &File{
		ID:          w.ID,
		Project:     w.Project,
		Status:      w.Status,
		Name:        w.Name,
		MimeType:    w.MimeType,
		Size:        w.Size,
		ContentHash: w.ContentHash,
		OwnerRef:    w.OwnerRef,
		Visibility:  w.Visibility,
		PublicURL:   w.PublicURL,
		Metadata:    w.Metadata,
		CreatedAt:   w.CreatedAt,
		DeletedAt:   w.DeletedAt,
	}
	if f.Metadata == nil {
		f.Metadata = map[string]any{}
	}
	if w.Download != nil {
		f.Download = &Download{URL: w.Download.URL, ExpiresAt: w.Download.ExpiresAt}
	}
	return f
}

type wireUpload struct {
	Mode      UploadMode        `json:"mode"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	PartSize  int64             `json:"part_size"`
	PartCount int               `json:"part_count"`
	ExpiresAt time.Time         `json:"expires_at"`
}

func (w wireUpload) toInstructions() UploadInstructions {
	return UploadInstructions{
		Mode:      w.Mode,
		URL:       w.URL,
		Headers:   w.Headers,
		PartSize:  w.PartSize,
		PartCount: w.PartCount,
		ExpiresAt: w.ExpiresAt,
	}
}
