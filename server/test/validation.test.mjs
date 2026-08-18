import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_SIZE_BYTES, validateCreateShare } from "../src/validation.mjs";

test("accepts a supported expiry and preserves file metadata", () => {
  assert.deepEqual(
    validateCreateShare({
      filename: "photo.jpg",
      size: 123,
      contentType: "image/jpeg",
      expiresInSeconds: 3600
    }),
    {
      filename: "photo.jpg",
      size: 123,
      contentType: "image/jpeg",
      expiresInSeconds: 3600
    }
  );
});

test("rejects unsupported expiry values", () => {
  assert.throws(
    () => validateCreateShare({ filename: "x.txt", size: 1, expiresInSeconds: 42 }),
    /expiry must be one of the supported timeframes/
  );
});

test("rejects files larger than the personal-use limit", () => {
  assert.throws(
    () => validateCreateShare({ filename: "big.bin", size: MAX_FILE_SIZE_BYTES + 1, expiresInSeconds: 3600 }),
    /file size is invalid/
  );
});

test("accepts a file at the 5 GB single-upload limit", () => {
  const result = validateCreateShare({ filename: "large.bin", size: MAX_FILE_SIZE_BYTES, expiresInSeconds: 3600 });
  assert.equal(result.size, MAX_FILE_SIZE_BYTES);
});
