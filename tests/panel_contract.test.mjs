import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("local panel exposes the public bridge workflow without technical IDs", () => {
  const html = fs.readFileSync(path.join(repoRoot, "ui", "panel.html"), "utf8");
  for (const label of ["status-only", "当前连接状态", "ChatGPT Web", "DeepSeek Web"]) {
    assert.match(html, new RegExp(label));
  }
  for (const endpoint of ["/api/status"]) {
    assert.match(html, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(html, /body\.status-only \.actions/);
  assert.match(html, /setInterval\(refresh, 2500\)/);
  assert.doesNotMatch(html, /session_id|targetId|route_id/);
});
