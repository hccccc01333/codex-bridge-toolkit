import { spawn } from "node:child_process";
import readline from "node:readline";

function text(value) {
  return String(value ?? "").trim();
}

export function createMcpClient({ command = process.execPath, args = [], cwd = process.cwd(), env = process.env } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });

  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message?.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "MCP request failed");
      error.code = message.error.code || "MCP_REQUEST_FAILED";
      request.reject(error);
      return;
    }
    request.resolve(message.result);
  });

  const rejectAll = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once("error", error => {
    closed = true;
    rejectAll(error);
  });
  child.once("exit", code => {
    closed = true;
    rejectAll(new Error(`MCP child exited with code ${code ?? "unknown"}`));
  });

  async function request(method, params = {}) {
    if (closed || !child.stdin.writable) throw new Error("MCP panel backend is unavailable");
    const id = nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${message}\n`);
    return result;
  }

  async function initialize() {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chatgpt-web-bridge-panel", version: "0.1.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  }

  async function callTool(name, arguments_ = {}) {
    const result = await request("tools/call", { name, arguments: arguments_ });
    return {
      text: text(result?.content?.find(item => item.type === "text")?.text),
      structuredContent: result?.structuredContent || {},
      isError: Boolean(result?.isError),
      raw: result,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
    rejectAll(new Error("MCP panel backend closed"));
  }

  return Object.freeze({ request, initialize, callTool, close, child });
}
