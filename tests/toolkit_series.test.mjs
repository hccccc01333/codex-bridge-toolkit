import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { listToolkits, TOOLKIT_SERIES_VERSION } from "../src/toolkits/registry.mjs";
import { inspectGithubWorkspace } from "../src/toolkits/github_workspace.mjs";
import { scanBrowser } from "../src/toolkits/browser_watchdog.mjs";
import { hostCompatibilityStatus } from "../src/toolkits/host_compatibility.mjs";
import { inspectArtifactWorkspace, readArtifactContext } from "../src/toolkits/artifact_workspace.mjs";
import { newSwarmRecord, publicSwarm, workerContextOf } from "../src/orchestration/swarm_state.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("toolkit registry exposes the stable series without mixing responsibilities", () => {
  const toolkits = listToolkits();
  assert.equal(TOOLKIT_SERIES_VERSION, "0.8.0");
  assert.deepEqual(toolkits.map(toolkit => toolkit.id), ["web-bridge", "executor-hosts", "browser-watchdog", "github-workspace", "mcp-host-compatibility", "artifact-workspace", "web-session-swarm"]);
  assert.ok(toolkits.find(toolkit => toolkit.id === "browser-watchdog").tools.includes("browser_watchdog_scan"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "github-workspace").tools.includes("github_workspace_status"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "github-workspace").tools.includes("github_workspace_bind"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "mcp-host-compatibility").tools.includes("bridge_host_status"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "artifact-workspace").tools.includes("artifact_workspace_status"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "artifact-workspace").tools.includes("artifact_workspace_read"));
  assert.ok(toolkits.find(toolkit => toolkit.id === "web-session-swarm").tools.includes("bridge_swarm_create"));
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

test("host compatibility reports generic MCP support without overstating DevSpace or web support", () => {
  const devspace = hostCompatibilityStatus({ host: "devspace" });
  assert.equal(devspace.selected_host, "devspace");
  assert.equal(devspace.selected.status, "generic_mcp_compatible");
  assert.ok(devspace.selected.notes.some(note => note.includes("尚未实现")));

  const web = hostCompatibilityStatus({ host: "chatgpt_web" });
  assert.equal(web.selected.status, "not_supported_as_mcp_host");
  assert.equal(web.safety.credentials, "never_collected");

  const opencode = hostCompatibilityStatus({ host: "opencode" });
  assert.equal(opencode.selected.status, "supported");
  assert.match(opencode.selected.transport, /stdio/);
});

test("artifact workspace is read-only and returns bounded local metadata", async () => {
  const result = await inspectArtifactWorkspace({ cwd: repoRoot, max_depth: 2, max_files: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.read_only, true);
  assert.equal(result.privacy.includes("不读取文档正文"), true);
  assert.ok(Array.isArray(result.artifacts));
  assert.equal(result.integrations.notion.api_adapter, false);
  assert.ok(result.artifacts.every(file => typeof file.relative_path === "string" && typeof file.bytes === "number"));
});

test("artifact context reads only explicitly selected bounded text and rejects unsafe paths", async () => {
  const result = await readArtifactContext({
    cwd: repoRoot,
    files: ["README.md"],
    max_total_chars: 1200,
    max_file_chars: 800,
  });
  assert.equal(result.ok, true);
  assert.equal(result.content_files, 1);
  assert.equal(result.items[0].state, "content_read");
  assert.equal(result.items[0].clipped, true);
  assert.match(result.items[0].content, /Codex/);

  const outside = await readArtifactContext({ cwd: repoRoot, files: ["../README.md"] });
  assert.equal(outside.ok, false);
  assert.equal(outside.items[0].state, "path_outside_workspace");
});

test("swarm public state hides internal identifiers and exposes fail-closed policy", () => {
  const swarm = newSwarmRecord({
    id: "test-swarm",
    name: "论文多模型组",
    workspace: { name: "repo", github: true, branch: "main", changes: [] },
  });
  swarm.members.push({
    label: "ChatGPT 1",
    worker_context: "internal-worker",
    route_id: "internal-route",
    session_id: "internal-session",
    runtime: { target_id: "internal-target" },
    link: { state: "ready", connected: true, provider: "ChatGPT Web", browser: "Edge 1", tab: { tab_index: 1, title: "ChatGPT", url: "https://chatgpt.com/c/example" } },
    watchdog: { lifecycle: "running", state: "healthy", checks: 2 },
    state: "ready",
  });
  const publicState = publicSwarm(swarm);
  assert.equal(publicState.safety_policy.auto_replace_tab, false);
  assert.equal(publicState.safety_policy.auto_resend, false);
  assert.equal(publicState.members[0].label, "ChatGPT 1");
  assert.doesNotMatch(JSON.stringify(publicState), /internal-worker|internal-route|internal-session|internal-target/);
  assert.equal(workerContextOf(swarm, swarm.members[0]).source, "swarm_worker_context");
});
