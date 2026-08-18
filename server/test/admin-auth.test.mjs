import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_SESSION_TTL_SECONDS, createAdminSession, verifyAdminSession } from "../src/admin-auth.mjs";

test("admin sessions are signed, tamper-resistant, and expire", () => {
  const now = 1_700_000_000;
  const session = createAdminSession("a-strong-admin-password", now);

  assert.equal(verifyAdminSession(session, "a-strong-admin-password", now + 1), true);
  assert.equal(verifyAdminSession(`${session}x`, "a-strong-admin-password", now + 1), false);
  assert.equal(verifyAdminSession(session, "wrong-password", now + 1), false);
  assert.equal(verifyAdminSession(session, "a-strong-admin-password", now + ADMIN_SESSION_TTL_SECONDS), false);
});
