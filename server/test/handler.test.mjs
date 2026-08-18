import test from "node:test";
import assert from "node:assert/strict";

process.env.UPLOAD_SECRET = "test-upload-secret";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.PUBLIC_BASE_URL = "https://share.example.com";

const { handler } = await import("../src/handler.mjs");

function event(method, path, body, headers = {}) {
  return { httpMethod: method, path, body: body && JSON.stringify(body), headers };
}

test("handler rejects unauthenticated mutations", async () => {
  const response = await handler(event("POST", "/shares", {}));
  assert.equal(response.statusCode, 401);
});

test("handler validates an authenticated create request before AWS calls", async () => {
  const response = await handler(event("POST", "/shares", { expiresInSeconds: 42 }, {
    authorization: "Bearer test-upload-secret"
  }));
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /filename/);
});

test("admin login issues a hardened session cookie", async () => {
  const response = await handler(event("POST", "/admin/login", { password: "test-admin-password" }));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
});

test("handler returns 404 for unknown routes", async () => {
  const response = await handler(event("GET", "/missing"));
  assert.equal(response.statusCode, 404);
});
