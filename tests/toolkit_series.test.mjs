import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { listToolkits, TOOLKIT_SERIES_VERSION } from "../src/toolkits/registry.mjs";
import { inspectGithubWorkspace } from "../src/toolkits/github_workspace.mjs";
import { scanBrowser } from "../src/toolkits/browser_watchdog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("toolkit registry exposes the stable series without mixing responsibilities", () => {
  const toolkits = listToolkits();
  assert.equal(TOOLKIT_SERIES_VERSION, "0.3.0");
  assert.deepEqual(toolkits.map(toolkit => toolkit.id), ["web-bridge", "browser-watchdog", "github-workspace"]);
  assert.ok(toolkits.find(toolkit => toolkit.id === "browser-watchdog").tools.includes("browser_watchdog_scan"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "github-workspace").tools.includes("github_workspace_status"));
});

test("GitHub workspace toolkit is read-only and returns branch/remotes/change evidence", async () => {
  const result = await inspectGithubWorkspace({ cwd: repoRoot });
  assert.equal(result.ok, true);
  assert.equal(result.read_only, true);
  assert.equal(typeof result.repository.root, "string");
  assert.equal(typeof result.branch, "string");
  assert.ok(Array.isArray(result.remotes));
  assert.ok(Array.isArray(result.changes));
  assert.ok(result.next_safe_actions.some(action => action.includes("提交")));
});

test("browser watchdog fails closed when no debugging endpoint is reachable", async () => {
  const result = await scanBrowser({ port: 1, timeout_ms: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.state, "browser_unreachable");
  assert.equal(result.provider, "chatgpt");
  assert.equal(result.port, 1);
});
