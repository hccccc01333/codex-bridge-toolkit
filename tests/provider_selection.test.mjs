import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(os.tmpdir(), `codex-chatgpt-bridge-provider-selection-${process.pid}`);

function startServer() {
  const child = spawn(process.execPath, ["scripts/mcp_server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LOCALAPPDATA: path.join(testRoot, "localappdata"),
      CODEX_BRIDGE_DB_PATH: path.join(testRoot, "control-plane.sqlite"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(message.id);
      if (!resolver) continue;
      pending.delete(message.id);
      resolver.resolve(message);
    }
  });
  child.stderr.resume();
  child.once("error", error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

test("provider selection is exposed as an enum and persists on a session", async () => {
  const server = startServer();
  try {
    const toolsResponse = await server.request("tools/list");
    const toolkitListTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_toolkit_list");
    const toolkitStatusTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_toolkit_status");
    const linkListTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_link_list");
    const watchdogTool = toolsResponse.result.tools.find(tool => tool.name === "browser_watchdog_scan");
    const githubTool = toolsResponse.result.tools.find(tool => tool.name === "github_workspace_status");
    const githubBindTool = toolsResponse.result.tools.find(tool => tool.name === "github_workspace_bind");
    const hostStatusTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_host_status");
    const artifactStatusTool = toolsResponse.result.tools.find(tool => tool.name === "artifact_workspace_status");
    const artifactReadTool = toolsResponse.result.tools.find(tool => tool.name === "artifact_workspace_read");
    const swarmCreateTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_swarm_create");
    const swarmStatusTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_swarm_status");
    assert.ok(toolkitListTool);
    assert.ok(toolkitStatusTool);
    assert.ok(linkListTool);
    assert.ok(watchdogTool);
    assert.ok(githubTool);
    assert.ok(githubBindTool);
    assert.ok(hostStatusTool);
    assert.ok(artifactStatusTool);
    assert.ok(artifactReadTool);
    assert.ok(swarmCreateTool);
    assert.ok(swarmStatusTool);
    assert.equal(hostStatusTool.inputSchema.properties.session_id, undefined);
    assert.equal(artifactStatusTool.inputSchema.properties.session_id, undefined);
    assert.equal(artifactReadTool.inputSchema.properties.session_id, undefined);
    assert.equal(swarmCreateTool.inputSchema.properties.session_id, undefined);
    assert.equal(swarmStatusTool.inputSchema.properties.session_id, undefined);
    assert.deepEqual(swarmCreateTool.inputSchema.properties.members.maxItems, 32);
    const sessionTool = toolsResponse.result.tools.find(tool => tool.name === "brain_browser_session_create");
    const planTool = toolsResponse.result.tools.find(tool => tool.name === "brain_plan");
    const routeTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_route_create");
    const runTool = toolsResponse.result.tools.find(tool => tool.name === "run_round");
    const openTool = toolsResponse.result.tools.find(tool => tool.name === "chatgpt_browser_open");
    const connectTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_connect");
    const goalTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_goal_create");
    const discoverTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_discover");
    const focusTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_focus");
    const sendTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_send");
    const receiveTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_receive");
    const panelTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_panel");
    const pauseTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_pause");
    const disconnectTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_disconnect");
    assert.deepEqual(sessionTool.inputSchema.properties.brain_provider.enum, ["chatgpt", "deepseek"]);
    assert.equal(sessionTool.inputSchema.properties.brain_provider.default, "chatgpt");
    assert.deepEqual(planTool.inputSchema.properties.brain_provider.enum, ["chatgpt", "deepseek"]);
    assert.equal(planTool.inputSchema.properties.brain_provider.default, undefined);
    assert.deepEqual(routeTool.inputSchema.properties.executor_provider.enum, ["chatgpt_luna", "deepseek_api", "codex_current", "opencode"]);
    assert.equal(routeTool.inputSchema.properties.executor_provider.default, "chatgpt_luna");
    assert.equal(runTool.inputSchema.properties.executor_model.type, "string");
    assert.ok(openTool.inputSchema.properties.target_id);
    assert.ok(openTool.inputSchema.properties.target_title);
    assert.ok(openTool.inputSchema.properties.target_url);
    assert.deepEqual(connectTool.inputSchema.properties.mode.enum, ["one_shot", "bounded", "continuous"]);
    assert.deepEqual(connectTool.inputSchema.properties.rounds, { type: "integer", minimum: 0, maximum: 50, default: 1, description: "0 means manual linked mode; 1-50 means bounded relay rounds." });
    assert.equal(discoverTool.inputSchema.properties.provider.default, "chatgpt");
    assert.equal(discoverTool.inputSchema.properties.auto_launch.default, true);
    assert.equal(connectTool.inputSchema.properties.auto_launch.default, true);
    assert.ok(goalTool);
    assert.deepEqual(goalTool.inputSchema.required, ["answer"]);
    assert.equal(connectTool.inputSchema.properties.session_id, undefined);
    assert.equal(connectTool.inputSchema.properties.target_id, undefined);
    assert.ok(focusTool.inputSchema.properties.tab);
    assert.ok(sendTool.inputSchema.properties.message);
    assert.ok(receiveTool);
    assert.ok(panelTool);
    assert.ok(panelTool.inputSchema.properties.label);
    assert.equal(panelTool.inputSchema.properties.external.default, false);
    assert.equal(panelTool._meta.ui.resourceUri, "ui://codex-web-bridge/control-panel-v1.html");
    assert.ok(pauseTool);
    assert.ok(disconnectTool);

    const resources = await server.request("resources/list");
    assert.equal(resources.result.resources[0].uri, "ui://codex-web-bridge/control-panel-v1.html");
    assert.equal(resources.result.resources[0].mimeType, "text/html;profile=mcp-app");
    const resource = await server.request("resources/read", { uri: "ui://codex-web-bridge/control-panel-v1.html" });
    assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.result.contents[0].text, /ui\/notifications\/tool-result/);
    assert.match(resource.result.contents[0].text, /tools\/call/);
    assert.match(resource.result.contents[0].text, /status-only/);
    assert.match(resource.result.contents[0].text, /bridge-link/);
    assert.doesNotMatch(resource.result.contents[0].text, /ui\/message/);
    assert.doesNotMatch(resource.result.contents[0].text, /id="goal"/);
    assert.doesNotMatch(resource.result.contents[0].text, /fetch\(/);

    const panel = await server.request("tools/call", { name: "bridge_panel", arguments: {} });
    assert.equal(panel.result.structuredContent.native_ui, true);
    assert.equal(panel.result._meta.ui.resourceUri, "ui://codex-web-bridge/control-panel-v1.html");

    const toolkitList = await server.request("tools/call", { name: "bridge_toolkit_list", arguments: {} });
    assert.equal(toolkitList.result.structuredContent.series_version, "0.8.0");
    assert.ok(toolkitList.result.structuredContent.toolkits.some(toolkit => toolkit.id === "mcp-host-compatibility"));
    assert.ok(toolkitList.result.structuredContent.toolkits.some(toolkit => toolkit.id === "artifact-workspace"));
    assert.deepEqual(toolkitList.result.structuredContent.toolkits.map(toolkit => toolkit.id), ["web-bridge", "executor-hosts", "browser-watchdog", "github-workspace", "mcp-host-compatibility", "artifact-workspace", "web-session-swarm"]);

    const toolkitStatus = await server.request("tools/call", { name: "bridge_toolkit_status", arguments: {} });
    assert.ok(Array.isArray(toolkitStatus.result.structuredContent.links));

    const linkList = await server.request("tools/call", { name: "bridge_link_list", arguments: {} });
    assert.ok(Array.isArray(linkList.result.structuredContent.links));
    assert.doesNotMatch(JSON.stringify(linkList.result.structuredContent), /route_id|session_id|target_id/);

    const watchdogStart = await server.request("tools/call", {
      name: "browser_watchdog_start",
      arguments: { name: "test-watchdog", route_id: "watchdog-route", port: 1, timeout_ms: 500 },
    });
    assert.equal(watchdogStart.result.structuredContent.started, true);
    assert.equal(watchdogStart.result.structuredContent.watchdog.lifecycle, "running");
    assert.equal(watchdogStart.result.structuredContent.watchdog.state, "browser_unreachable");
    assert.equal(watchdogStart.result.structuredContent.watchdog.alert_count, 1);
    const watchdogRoute = await server.request("tools/call", {
      name: "bridge_route_status",
      arguments: { route_id: "watchdog-route" },
    });
    assert.equal(watchdogRoute.result.structuredContent.route.browser_health.state, "browser_unreachable");
    const watchdogStop = await server.request("tools/call", {
      name: "browser_watchdog_stop",
      arguments: { name: "test-watchdog" },
    });
    assert.equal(watchdogStop.result.structuredContent.stopped, true);

    const workspace = await server.request("tools/call", { name: "github_workspace_status", arguments: { cwd: repoRoot } });
    assert.equal(workspace.result.structuredContent.ok, true);
    assert.equal(workspace.result.structuredContent.read_only, true);

    const hostStatus = await server.request("tools/call", { name: "bridge_host_status", arguments: { host: "devspace" } });
    assert.equal(hostStatus.result.structuredContent.selected_host, "devspace");
    assert.equal(hostStatus.result.structuredContent.selected.status, "generic_mcp_compatible");

    const artifacts = await server.request("tools/call", { name: "artifact_workspace_status", arguments: { cwd: repoRoot, max_depth: 1, max_files: 10 } });
    assert.equal(artifacts.result.structuredContent.ok, true);
    assert.equal(artifacts.result.structuredContent.read_only, true);
    assert.equal(artifacts.result.structuredContent.integrations.notion.api_adapter, false);
    const artifactRead = await server.request("tools/call", { name: "artifact_workspace_read", arguments: { cwd: repoRoot, files: ["README.md"], max_total_chars: 1200, max_file_chars: 800 } });
    assert.equal(artifactRead.result.structuredContent.ok, true);
    assert.equal(artifactRead.result.structuredContent.content_files, 1);

    const providerList = await server.request("tools/call", { name: "brain_provider_list", arguments: {} });
    assert.equal(providerList.result.structuredContent.default_provider, "chatgpt");
    assert.deepEqual(providerList.result.structuredContent.providers.map(provider => provider.id), ["chatgpt", "deepseek"]);

    const executorList = await server.request("tools/call", { name: "executor_provider_list", arguments: {} });
    assert.equal(executorList.result.structuredContent.default_provider, "chatgpt_luna");
    assert.deepEqual(executorList.result.structuredContent.providers.map(provider => provider.id), ["chatgpt_luna", "deepseek_api", "codex_current", "opencode"]);
    assert.deepEqual(executorList.result.structuredContent.providers[1].models, ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(executorList.result.structuredContent.providers[2].inherit_config, true);
    assert.equal(executorList.result.structuredContent.providers[3].kind, "opencode");

    const created = await server.request("tools/call", {
      name: "brain_browser_session_create",
      arguments: { session_id: "deepseek-selection", brain_provider: "deepseek" },
    });
    assert.equal(created.result.structuredContent.session.brain_provider, "deepseek");

    const defaultCreated = await server.request("tools/call", {
      name: "brain_browser_session_create",
      arguments: { session_id: "chatgpt-default" },
    });
    assert.equal(defaultCreated.result.structuredContent.session.brain_provider, "chatgpt");

    const status = await server.request("tools/call", {
      name: "brain_status",
      arguments: { session_id: "deepseek-selection" },
    });
    assert.equal(status.result.structuredContent.brain_provider, "deepseek");

    const route = await server.request("tools/call", {
      name: "bridge_route_create",
      arguments: {
        route_id: "deepseek-flash-route",
        session_id: "deepseek-selection",
        brain_provider: "deepseek",
        executor_provider: "deepseek_api",
        executor_model: "deepseek-v4-flash",
        executor_profile: "my-deepseek",
      },
    });
    assert.equal(route.result.structuredContent.route.brain_provider, "deepseek");
    assert.equal(route.result.structuredContent.route.executor_provider, "deepseek_api");
    assert.equal(route.result.structuredContent.route.executor_model, "deepseek-v4-flash");
    assert.equal(route.result.structuredContent.route.executor_profile, "my-deepseek");
  } finally {
    server.stop();
  }
});

test("explicit browser target selectors fail closed", async () => {
  const browser = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      { id: "chatgpt-a", type: "page", title: "ChatGPT A", url: "https://chatgpt.com/c/a" },
      { id: "chatgpt-b", type: "page", title: "Same title", url: "https://chatgpt.com/c/b" },
      { id: "chatgpt-c", type: "page", title: "Same title", url: "https://chatgpt.com/c/c" },
      { id: "deepseek-a", type: "page", title: "DeepSeek", url: "https://chat.deepseek.com/a/chat/s-1" },
    ]));
  });
  await new Promise(resolve => browser.listen(0, "127.0.0.1", resolve));
  const port = browser.address().port;
  const server = startServer();
  try {
    const missing = await server.request("tools/call", {
      name: "chatgpt_browser_open",
      arguments: { port, target_id: "does-not-exist" },
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /target ID not found/);

    const ambiguous = await server.request("tools/call", {
      name: "chatgpt_browser_open",
      arguments: { port, target_title: "Same title" },
    });
    assert.equal(ambiguous.result.isError, true);
    assert.match(ambiguous.result.content[0].text, /title is ambiguous/);

    const wrongProvider = await server.request("tools/call", {
      name: "chatgpt_browser_open",
      arguments: { port, target_url: "https://chat.deepseek.com/a/chat/s-1" },
    });
    assert.equal(wrongProvider.result.isError, true);
    assert.match(wrongProvider.result.content[0].text, /not a ChatGPT Web page/);
  } finally {
    server.stop();
    await new Promise(resolve => browser.close(resolve));
  }
});
