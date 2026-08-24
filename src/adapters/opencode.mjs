const DEFAULT_ENDPOINT = "http://127.0.0.1:4096";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function clip(value, limit = 12000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function textFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.output === "string") return part.output;
  if (typeof part.content === "string") return part.content;
  if (typeof part.state?.output === "string") return part.state.output;
  return "";
}

function textFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.map(textFromPart).filter(Boolean).join("\n");
}

function normalizeEndpoint(value = DEFAULT_ENDPOINT) {
  const raw = String(value || DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch {
    const error = new Error("OpenCode endpoint must be an absolute http(s) URL");
    error.code = "OPENCODE_ENDPOINT_INVALID";
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error("OpenCode endpoint must use http or https");
    error.code = "OPENCODE_ENDPOINT_INVALID";
    throw error;
  }
  if (url.username || url.password) {
    const error = new Error("OpenCode endpoint must not contain credentials; use OPENCODE_SERVER_USERNAME/PASSWORD");
    error.code = "OPENCODE_ENDPOINT_CREDENTIALS_FORBIDDEN";
    throw error;
  }
  return url.toString().replace(/\/$/, "");
}

function basicAuth(username, password) {
  if (!password) return null;
  return `Basic ${Buffer.from(`${username || "opencode"}:${password}`).toString("base64")}`;
}

export class OpenCodeAdapter {
  constructor({
    endpoint = process.env.OPENCODE_SERVER_URL || DEFAULT_ENDPOINT,
    cwd = process.cwd(),
    model = null,
    agent = null,
    username = process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password = process.env.OPENCODE_SERVER_PASSWORD || "",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("OpenCode Adapter requires fetch");
    this.endpoint = normalizeEndpoint(endpoint);
    this.cwd = cwd;
    this.model = model || null;
    this.agent = agent || null;
    this.username = username || "opencode";
    this.password = password || "";
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.state = "disconnected";
    this.lastError = null;
    this.server = null;
    this.activeSessionId = null;
  }

  async request(pathname, { method = "GET", body, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { accept: "application/json" };
    const authorization = basicAuth(this.username, this.password);
    if (authorization) headers.authorization = authorization;
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
      if (!response.ok) {
        const error = new Error(`OpenCode server returned ${response.status}: ${clip(typeof parsed === "string" ? parsed : parsed?.message || response.statusText)}`);
        error.code = response.status === 401 ? "OPENCODE_AUTH_REQUIRED" : "OPENCODE_REQUEST_FAILED";
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error(`OpenCode request timed out: ${method} ${pathname}`);
        timeout.code = "OPENCODE_ADAPTER_TIMEOUT";
        throw timeout;
      }
      if (error?.code?.startsWith("OPENCODE_")) throw error;
      const unavailable = new Error(`OpenCode server unavailable at ${this.endpoint}: ${String(error)}`);
      unavailable.code = "OPENCODE_ADAPTER_UNAVAILABLE";
      throw unavailable;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect() {
    if (this.state === "ready") return this;
    this.state = "starting";
    this.lastError = null;
    try {
      this.server = await this.request("/global/health", { timeoutMs: Math.min(this.timeoutMs, 10000) });
      if (this.server?.healthy === false) throw new Error("OpenCode server reported unhealthy");
      this.state = "ready";
      return this;
    } catch (error) {
      this.state = "unavailable";
      this.lastError = String(error);
      throw error;
    }
  }

  async startThread({ thread_id, title = "Codex Bridge task" } = {}) {
    await this.connect();
    if (thread_id) {
      const session = await this.request(`/session/${encodeURIComponent(thread_id)}`);
      this.activeSessionId = session?.id || thread_id;
      return { session, thread_id: this.activeSessionId };
    }
    const session = await this.request("/session", {
      method: "POST",
      body: { title: clip(title, 200) },
    });
    const id = session?.id || session?.sessionID || session?.session_id;
    if (!id) {
      const error = new Error("OpenCode did not return a session id");
      error.code = "OPENCODE_SESSION_ID_MISSING";
      throw error;
    }
    this.activeSessionId = id;
    return { session, thread_id: id };
  }

  async sendTask({ thread_id, text, input, timeoutMs = this.timeoutMs, model = this.model, agent = this.agent } = {}) {
    if (!thread_id) throw new Error("opencode_session_id is required");
    const textInput = Array.isArray(input)
      ? input.map(item => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n")
      : String(text || "").trim();
    if (!textInput) throw new Error("task text or input is required");
    await this.connect();
    const body = {
      parts: [{ type: "text", text: clip(textInput) }],
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    };
    const response = await this.request(`/session/${encodeURIComponent(thread_id)}/message`, {
      method: "POST",
      body,
      timeoutMs,
    });
    const info = response?.info || response?.message || {};
    const result = {
      thread_id,
      turn_id: info.id || info.messageID || null,
      completed: true,
      text: clip(textFromMessage(response)),
      response,
    };
    this.activeSessionId = thread_id;
    return result;
  }

  async readThread(thread_id, { limit = 20 } = {}) {
    if (!thread_id) throw new Error("opencode_session_id is required");
    await this.connect();
    return this.request(`/session/${encodeURIComponent(thread_id)}/message?limit=${encodeURIComponent(limit)}`);
  }

  async setThreadGoal({ thread_id, objective, status = "active", tokenBudget = null } = {}) {
    const goal = String(objective || "").trim();
    if (!goal) throw new Error("goal objective is required");
    // OpenCode has a session/todo model rather than Codex's thread/goal/set.
    // The Bridge Goal remains authoritative and is persisted by the control plane.
    return {
      goal: { objective: goal, status, tokenBudget: tokenBudget ?? null },
      local_only: true,
      method: "bridge_goal",
      thread_id: thread_id || null,
    };
  }

  async getThreadGoal() {
    const error = new Error("OpenCode does not expose Codex native Goal API; use the Bridge Goal");
    error.code = "OPENCODE_NATIVE_GOAL_UNSUPPORTED";
    throw error;
  }

  async clearThreadGoal() {
    const error = new Error("OpenCode does not expose Codex native Goal API; use bridge_goal_create to replace the Bridge Goal");
    error.code = "OPENCODE_NATIVE_GOAL_UNSUPPORTED";
    throw error;
  }

  status() {
    return {
      state: this.state,
      endpoint: this.endpoint,
      cwd: this.cwd,
      model: this.model,
      agent: this.agent,
      active_session_id: this.activeSessionId,
      server: this.server ? { healthy: this.server.healthy, version: this.server.version || null } : null,
      last_error: this.lastError,
      native_goal: false,
    };
  }

  close() {
    this.state = "closed";
    this.activeSessionId = null;
  }
}

export function createOpenCodeAdapter(options = {}) {
  return new OpenCodeAdapter(options);
}

export { DEFAULT_ENDPOINT as DEFAULT_OPENCODE_ENDPOINT, normalizeEndpoint as normalizeOpenCodeEndpoint };
