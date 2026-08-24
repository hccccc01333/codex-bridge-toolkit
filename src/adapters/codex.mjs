import { spawn as defaultSpawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 120000;

export function defaultCodexCommand({ platform = process.platform, env = process.env } = {}) {
  const override = String(env?.CODEX_BRIDGE_CODEX_COMMAND || "").trim();
  if (override) return override;
  return platform === "win32" ? "codex.cmd" : "codex";
}

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

export function codexSpawnSpec(command, args = [], { platform = process.platform, env = process.env } = {}) {
  const normalizedCommand = String(command || "").trim() || defaultCodexCommand({ platform });
  const normalizedArgs = Array.isArray(args) ? [...args] : [];
  if (platform === "win32" && /\.(cmd|bat)$/i.test(normalizedCommand)) {
    const commandLine = [normalizedCommand, ...normalizedArgs].map(quoteWindowsCommandArgument).join(" ");
    return {
      command: env?.ComSpec || env?.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      options: {},
    };
  }
  if (platform === "win32" && /\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", normalizedCommand, ...normalizedArgs],
      options: {},
    };
  }
  return { command: normalizedCommand, args: normalizedArgs, options: {} };
}

export function codexThreadIdFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "codex:" || url.hostname.toLowerCase() !== "threads") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/.test(segments[0])) return null;
    return segments[0];
  } catch {
    return null;
  }
}

function textFromItem(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (!Array.isArray(item.content)) return "";
  return item.content.map(part => typeof part === "string" ? part : part?.text || "").join("");
}

export class CodexAdapter {
  constructor({
    command = undefined,
    args = ["app-server", "--listen", "stdio://"],
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = defaultSpawn,
    clientInfo = { name: "chatgpt-web-bridge", title: "ChatGPT Web Bridge", version: "0.1.0" },
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onNotification = null,
  } = {}) {
    this.command = String(command || defaultCodexCommand({ env })).trim();
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.clientInfo = clientInfo;
    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.child = null;
    this.state = "disconnected";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.turnText = new Map();
    this.lastError = null;
  }

  async connect() {
    if (this.child && this.state === "ready") return this;
    this.state = "starting";
    this.lastError = null;
    let child;
    try {
      const spawnSpec = codexSpawnSpec(this.command, this.args, { env: this.env });
      child = this.spawnImpl(spawnSpec.command, spawnSpec.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...spawnSpec.options,
      });
    } catch (error) {
      this.state = "unavailable";
      this.lastError = String(error);
      const wrapped = new Error(`Codex Adapter unavailable: ${this.lastError}`);
      wrapped.code = "CODEX_ADAPTER_UNAVAILABLE";
      throw wrapped;
    }
    this.child = child;
    child.on("error", error => this._fail(error));
    child.on("exit", (code, signal) => {
      if (this.state !== "closed") this._fail(new Error(`Codex app-server exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
    });
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", line => this._handleLine(line));
    child.stderr?.on("data", chunk => {
      this.lastError = String(chunk).trim() || this.lastError;
    });
    await this.request("initialize", { clientInfo: this.clientInfo });
    this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.state = "ready";
    return this;
  }

  _send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex Adapter is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextRequestId++;
    const request = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex Adapter request timed out: ${method}`);
        error.code = "CODEX_ADAPTER_TIMEOUT";
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _handleLine(line) {
    if (!String(line).trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Codex Adapter request failed: ${pending.method}`);
        error.code = message.error.code || "CODEX_ADAPTER_REQUEST_FAILED";
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      const error = { code: -32001, message: "approval or server interaction is required outside the adapter" };
      this._send({ jsonrpc: "2.0", id: message.id, error });
    }
    if (message.method) this._handleNotification(message);
  }

  _handleNotification(message) {
    const params = message.params || {};
    if (message.method === "item/agentMessage/delta") {
      const turnId = params.turnId || "unknown";
      this.turnText.set(turnId, `${this.turnText.get(turnId) || ""}${params.delta || ""}`);
    }
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const turnId = params.turnId || "unknown";
      const text = textFromItem(params.item);
      if (text) this.turnText.set(turnId, `${this.turnText.get(turnId) || ""}${text}`);
    }
    if (message.method === "turn/completed") {
      const turnId = params.turn?.id || params.turnId;
      const completed = {
        thread_id: params.threadId || null,
        turn_id: turnId || null,
        turn: params.turn || null,
        text: this.turnText.get(turnId) || "",
      };
      if (turnId) {
        this.completedTurns.set(turnId, completed);
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          clearTimeout(waiter.timer);
          waiter.resolve(completed);
        }
      }
    }
    this.onNotification?.(message);
  }

  _fail(error) {
    const wasStarting = this.state === "starting";
    const normalized = wasStarting
      ? Object.assign(new Error(`Codex Adapter unavailable: ${String(error)}`), { code: "CODEX_ADAPTER_UNAVAILABLE" })
      : error;
    this.lastError = String(normalized);
    this.state = "unavailable";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(normalized);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(normalized);
    }
    this.turnWaiters.clear();
  }

  async startThread({ thread_id, cwd = this.cwd, model = null, baseInstructions = null, approvalPolicy = null } = {}) {
    await this.connect();
    const method = thread_id ? "thread/resume" : "thread/start";
    const params = thread_id
      ? { threadId: thread_id }
      : { cwd, model, baseInstructions, approvalPolicy };
    const result = await this.request(method, Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== undefined)));
    const thread = result?.thread || {};
    return { ...result, thread_id: thread.id || thread_id || null };
  }

  async sendTask({ thread_id, text, input, timeoutMs = this.timeoutMs, ...overrides } = {}) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    if (!String(text || "").trim() && !Array.isArray(input)) throw new Error("task text or input is required");
    await this.connect();
    const requestResult = await this.request("turn/start", {
      threadId: thread_id,
      input: input || [{ type: "text", text: String(text).trim() }],
      ...overrides,
    });
    const turnId = requestResult?.turn?.id;
    if (!turnId) return { ...requestResult, thread_id, completed: false, text: "" };
    const existing = this.completedTurns.get(turnId);
    if (existing) return { ...requestResult, ...existing, completed: true };
    const completion = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        const error = new Error(`Codex turn timed out: ${turnId}`);
        error.code = "CODEX_ADAPTER_TIMEOUT";
        reject(error);
      }, timeoutMs);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
    return { ...requestResult, ...completion, completed: true };
  }

  async readThread(thread_id) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    await this.connect();
    return this.request("thread/read", { threadId: thread_id });
  }

  async setThreadGoal({ thread_id, objective, status = "active", tokenBudget = null } = {}) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    const goal = String(objective || "").trim();
    if (!goal) throw new Error("goal objective is required");
    if (goal.length > 4000) throw new Error("goal objective must be at most 4000 characters");
    await this.connect();
    const params = {
      threadId: thread_id,
      objective: goal,
      status: String(status || "active"),
    };
    if (tokenBudget !== null && tokenBudget !== undefined) {
      params.tokenBudget = tokenBudget;
    }
    return this.request("thread/goal/set", params);
  }

  async getThreadGoal(thread_id) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    await this.connect();
    return this.request("thread/goal/get", { threadId: thread_id });
  }

  async clearThreadGoal(thread_id) {
    if (!thread_id) throw new Error("codex_thread_id is required");
    await this.connect();
    return this.request("thread/goal/clear", { threadId: thread_id });
  }

  status() {
    return {
      state: this.state,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      last_error: this.lastError,
      pending_requests: this.pending.size,
      active_turns: this.turnWaiters.size,
    };
  }

  close() {
    this.state = "closed";
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    for (const waiter of this.turnWaiters.values()) clearTimeout(waiter.timer);
    this.pending.clear();
    this.turnWaiters.clear();
    this.child?.kill?.();
    this.child = null;
  }
}

export function createCodexAdapter(options = {}) {
  return new CodexAdapter(options);
}
