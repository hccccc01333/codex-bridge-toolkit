import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
      resolver(message);
    }
  });
  child.stderr.resume();
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.once("error", reject);
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
    const sessionTool = toolsResponse.result.tools.find(tool => tool.name === "brain_browser_session_create");
    const planTool = toolsResponse.result.tools.find(tool => tool.name === "brain_plan");
    const routeTool = toolsResponse.result.tools.find(tool => tool.name === "bridge_route_create");
    const runTool = toolsResponse.result.tools.find(tool => tool.name === "run_round");
    assert.deepEqual(sessionTool.inputSchema.properties.brain_provider.enum, ["chatgpt", "deepseek"]);
    assert.equal(sessionTool.inputSchema.properties.brain_provider.default, "chatgpt");
    assert.deepEqual(planTool.inputSchema.properties.brain_provider.enum, ["chatgpt", "deepseek"]);
    assert.equal(planTool.inputSchema.properties.brain_provider.default, undefined);
    assert.deepEqual(routeTool.inputSchema.properties.executor_provider.enum, ["chatgpt_luna", "deepseek_api", "codex_current"]);
    assert.equal(routeTool.inputSchema.properties.executor_provider.default, "chatgpt_luna");
    assert.deepEqual(runTool.inputSchema.properties.executor_model.enum, ["gpt-5.6-luna", "deepseek-v4-pro", "deepseek-v4-flash"]);

    const providerList = await server.request("tools/call", { name: "brain_provider_list", arguments: {} });
    assert.equal(providerList.result.structuredContent.default_provider, "chatgpt");
    assert.deepEqual(providerList.result.structuredContent.providers.map(provider => provider.id), ["chatgpt", "deepseek"]);

    const executorList = await server.request("tools/call", { name: "executor_provider_list", arguments: {} });
    assert.equal(executorList.result.structuredContent.default_provider, "chatgpt_luna");
    assert.deepEqual(executorList.result.structuredContent.providers.map(provider => provider.id), ["chatgpt_luna", "deepseek_api", "codex_current"]);
    assert.deepEqual(executorList.result.structuredContent.providers[1].models, ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(executorList.result.structuredContent.providers[2].inherit_config, true);

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
