import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

test("admin page ships parseable browser logic and core controls", () => {
  const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  for (const id of ["loginForm", "dropzone", "fileRows", "statusFilter"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /\{\{BRAND_NAME\}\} Admin/);
});
