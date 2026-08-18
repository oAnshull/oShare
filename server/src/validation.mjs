export const EXPIRY_OPTIONS = Object.freeze([
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 6 * 60 * 60, label: "6 hours" },
  { seconds: 24 * 60 * 60, label: "1 day" },
  { seconds: 3 * 24 * 60 * 60, label: "3 days" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" }
]);

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

const expirySeconds = new Set(EXPIRY_OPTIONS.map((option) => option.seconds));

export function safeFilename(value) {
  const filename = typeof value === "string" ? value.trim() : "";
  if (!filename || filename.length > 255 || filename.includes("\0")) {
    throw new Error("filename must be between 1 and 255 characters");
  }

  return filename.replace(/[\\/:*?"<>|\r\n]/g, "_");
}

export function validateCreateShare(input) {
  if (!input || typeof input !== "object") {
    throw new Error("request body must be an object");
  }

  const filename = safeFilename(input.filename);
  const size = Number(input.size);
  const expiresInSeconds = Number(input.expiresInSeconds);

  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_SIZE_BYTES) {
    throw new Error("file size is invalid or exceeds the 5 GB limit");
  }

  if (!expirySeconds.has(expiresInSeconds)) {
    throw new Error("expiry must be one of the supported timeframes");
  }

  return {
    filename,
    size,
    contentType:
      typeof input.contentType === "string" && input.contentType.length <= 128
        ? input.contentType
        : "application/octet-stream",
    expiresInSeconds
  };
}
