import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE_NAME = "oshare_admin";
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

function signature(expiresAt, secret) {
  return createHmac("sha256", secret).update(String(expiresAt)).digest("base64url");
}

export function createAdminSession(secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) return "";
  const expiresAt = now + ADMIN_SESSION_TTL_SECONDS;
  return `${expiresAt}.${signature(expiresAt, secret)}`;
}

export function verifyAdminSession(value, secret, now = Math.floor(Date.now() / 1000)) {
  if (!value || !secret) return false;
  const [expiresAtText, suppliedSignature, extra] = value.split(".");
  const expiresAt = Number(expiresAtText);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const supplied = Buffer.from(suppliedSignature ?? "");
  const expected = Buffer.from(signature(expiresAt, secret));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
