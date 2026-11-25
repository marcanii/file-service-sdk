"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toFileInfo = toFileInfo;
exports.toUploadInstructions = toUploadInstructions;
exports.hasChecksumHeader = hasChecksumHeader;
/** snake_case de la API → camelCase del SDK. */
function toFileInfo(raw) {
    return {
        id: raw.id,
        project: raw.project,
        status: raw.status,
        name: raw.original_name,
        mimeType: raw.mime_type,
        size: raw.size_bytes,
        contentHash: raw.content_hash ?? undefined,
        ownerRef: raw.owner_ref ?? undefined,
        visibility: raw.visibility,
        publicUrl: raw.public_url || undefined,
        metadata: raw.metadata ?? {},
        createdAt: raw.created_at,
        deletedAt: raw.deleted_at ?? undefined,
        download: raw.download ? { url: raw.download.url, expiresAt: raw.download.expires_at } : undefined,
        reason: raw.reason || undefined,
    };
}
function toUploadInstructions(raw) {
    return {
        mode: raw.mode,
        url: raw.url || undefined,
        headers: raw.headers ?? undefined,
        partSize: raw.part_size || undefined,
        partCount: raw.part_count || undefined,
        expiresAt: raw.expires_at,
    };
}
/** Si las instrucciones del PUT traen el Checksum declarado firmado (`x-amz-checksum-sha256`). */
function hasChecksumHeader(headers) {
    return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === "x-amz-checksum-sha256");
}
