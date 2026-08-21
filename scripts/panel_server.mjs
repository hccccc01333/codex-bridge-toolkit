#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createMcpClient } from "../src/panel/mcp_client.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PANEL_HTML = path.join(REPO_ROOT, "ui", "panel.html");
const DEFAULT_PORT = 17841;

function text(value) {
  return String(value ?? "").trim();
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function panelMarkup(markup, context) {
  const safeContext = JSON.stringify(context).replaceAll("<", "\\u003c");
  return markup.replace("</head>", `<script>window.__BRIDGE_PANEL_CONTEXT__=${safeContext};</script></head>`);
}

function parsePort(value = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function readToken(request, url) {
  return text(request.headers["x-bridge-panel-token"] || url.searchParams.get("token"));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("panel request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("panel request must be valid JSON"); }
}

function openUrl(url) {
  if (process.platform === "win32") {
    const child = spawn(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function toolForPath(pathname) {
  return {
    "/api/discover": "bridge_discover",
    "/api/connect": "bridge_connect",
    "/api/status": "bridge_status",
    "/api/focus": "bridge_focus",
    "/api/send": "bridge_send",
    "/api/receive": "bridge_receive",
    "/api/run": "bridge_run",
    "/api/pause": "bridge_pause",
    "/api/disconnect": "bridge_disconnect",
  }[pathname] || "";
}

export async function createPanelServer({
  port = DEFAULT_PORT,
  token = crypto.randomBytes(24).toString("hex"),
  open = false,
  label = "当前 Codex 对话",
  panelId = crypto.randomBytes(3).toString("hex").toUpperCase(),
  callTool = null,
} = {}) {
  const backend = callTool ? null : createMcpClient({
    cwd: REPO_ROOT,
    args: [path.join(SCRIPT_DIR, "mcp_server.mjs")],
    env: { ...process.env, CODEX_BRIDGE_PANEL: "1" },
  });
  if (backend) await backend.initialize();
  const invokeTool = callTool || ((name, args) => backend.callTool(name, args));
  const markup = panelMarkup(fs.readFileSync(PANEL_HTML, "utf8"), { label: text(label) || "当前 Codex 对话", panel_id: panelId });
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (readToken(request, requestUrl) !== token) {
      json(response, 403, { error: "invalid panel token" });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/") {
      html(response, markup);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      json(response, 200, { ok: true, service: "chatgpt-web-bridge-panel" });
      return;
    }
    const tool = toolForPath(requestUrl.pathname);
    if (!tool || !["GET", "POST"].includes(request.method || "")) {
      json(response, 404, { error: "panel route not found" });
      return;
    }
    try {
      const args = request.method === "POST" ? await readBody(request) : Object.fromEntries(requestUrl.searchParams.entries());
      const raw = await invokeTool(tool, args);
      const result = raw?.text !== undefined
        ? raw
        : {
          text: text(raw?.content?.find(item => item.type === "text")?.text),
          structuredContent: raw?.structuredContent || {},
          isError: Boolean(raw?.isError),
        };
      json(response, result.isError ? 422 : 200, {
        ok: !result.isError,
        text: result.text,
        structuredContent: result.structuredContent,
      });
    } catch (error) {
      json(response, 503, { ok: false, error: String(error) });
    }
  });
  server.on("close", () => backend?.close());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsePort(port), "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : parsePort(port);
  const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
  if (open) openUrl(url);
  return { server, backend, port: actualPort, token, panelId, label: text(label) || "当前 Codex 对话", url };
}

function cliFlag(name) {
  return process.argv.includes(name);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? parsePort(process.argv[portIndex + 1]) : parsePort(process.env.CODEX_BRIDGE_PANEL_PORT);
  const tokenIndex = process.argv.indexOf("--token");
  const token = tokenIndex >= 0 ? text(process.argv[tokenIndex + 1]) : undefined;
  createPanelServer({ port, token, open: !cliFlag("--no-open") })
    .then(panel => {
      process.stdout.write(`Codex Web LLM panel: ${panel.url}${os.EOL}`);
    })
    .catch(error => {
      process.stderr.write(`${String(error)}${os.EOL}`);
      process.exitCode = 1;
    });
}
