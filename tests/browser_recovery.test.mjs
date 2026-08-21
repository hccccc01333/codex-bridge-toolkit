import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverSource = fs.readFileSync(path.join(repoRoot, "scripts", "mcp_server.mjs"), "utf8");

test("bound browser recovery fails closed instead of silently opening another tab", () => {
  assert.match(serverSource, /const pendingBrainTargetCreation = new Map\(\);/);
  assert.match(serverSource, /if \(stored && providerMatchesUrl\(provider, stored\.url\)\) return stored;\s+\/\/ A session that already owns a tab/);
  assert.match(serverSource, /if \(!page && allowCreate\) page = await createBrainTarget\(port, provider, session\);/);
  assert.match(serverSource, /the bound browser tab is unavailable; no new tab was opened automatically/);
  assert.match(serverSource, /send button not found; the bound tab was preserved and no new tab was opened/);
  assert.match(serverSource, /async function refreshBoundBrowserTab\(/);
  assert.match(serverSource, /cdpRaw\("Page\.reload", \{ ignoreCache: false \}\)/);
  assert.match(serverSource, /ensureConnected\(port, activeSession, provider, \{ allowCreate: false \}\)/);
  assert.match(serverSource, /refreshed_same_tab: refreshedSameTab/);
});

test("automatic dedicated-browser launch checks for an existing profile first", () => {
  assert.match(serverSource, /const existing = await localEdgeProcessCandidates\(\);/);
  assert.match(serverSource, /const alreadyRunning = existing\.some\(candidate => candidate\.userDataDir/);
  assert.match(serverSource, /dedicated browser is already running but its debugging endpoint is not ready/);
});
