import { spawn as defaultSpawn } from "node:child_process";
import readline from "node:readline";

function text(value) {
  return String(value ?? "").trim();
}

function hostKeyOf(args = {}) {
  const host = args.__host_codex_context || args.host_codex_context || args.codex_context;
  const threadId = text(host?.thread_id || host?.threadId || host?.codex_thread_id || host?.codexThreadId);
  if (threadId) return `thread:${threadId}`;
  const title = text(host?.title || host?.name || host?.conversation_title || host?.conversationTitle);
  if (title) return `title:${title}`;
  const routeId = text(args.route_id || args.routeId);
  if (routeId) return `route:${routeId}`;
  const sessionId = text(args.session_id || args.sessionId);
  if (sessionId) return `session:${sessionId}`;
  return "default";
}

function publicWorker(worker) {
  return {
    key: worker.key,
    state: worker.state,
    pending_requests: worker.pending.size,
    started_at: worker.started_at,
    last_used_at: worker.last_used_at,
  };
}

class RouteWorker {
  constructor({ key, script, cwd, env, spawnImpl = defaultSpawn, onExit = () => undefined } = {}) {
    this.key = key;
    this.script = script;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onExit = onExit;
    this.child = null;
    this.state = "starting";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.started_at = new Date().toISOString();
    this.last_used_at = this.started_at;
  }

  start() {
    if (this.child) return this;
    this.child = this.spawnImpl(process.execPath, [this.script], {
      cwd: this.cwd,
      env: { ...this.env, CODEX_BRIDGE_ROUTE_WORKER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.state = "ready";
    this.child.stdout?.setEncoding?.("utf8");
    const output = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    output.on("line", line => this.#handleLine(line));
    this.child.stderr?.resume?.();
    this.child.once?.("error", error => this.#fail(error));
    this.child.once?.("exit", (code, signal) => {
      if (this.state !== "closed") this.#fail(new Error(`route worker exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
      this.onExit(this);
    });
    return this;
  }

  #fail(error) {
    this.state = "unavailable";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #handleLine(line) {
    if (!text(line)) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  request(name, args = {}, { timeoutMs = 300000 } = {}) {
    if (!this.child || this.state === "closed" || this.state === "unavailable") {
      throw new Error("route worker is not available");
    }
    const id = this.nextRequestId++;
    this.last_used_at = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`route worker request timed out: ${name}`);
        error.code = "ROUTE_WORKER_TIMEOUT";
        reject(error);
      }, Math.max(1000, Number(timeoutMs) || 300000));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (!this.child) return;
    this.state = "closed";
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
    this.child = null;
  }
}

export class RouteWorkerPool {
  constructor({ script, cwd = process.cwd(), env = process.env, spawnImpl = defaultSpawn } = {}) {
    if (!script) throw new TypeError("route worker pool requires a server script");
    this.script = script;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.workers = new Map();
  }

  keyOf(args = {}) {
    return hostKeyOf(args);
  }

  workerFor(args = {}) {
    const key = this.keyOf(args);
    let worker = this.workers.get(key);
    if (!worker || ["closed", "unavailable"].includes(worker.state)) {
      worker?.close();
      worker = new RouteWorker({
        key,
        script: this.script,
        cwd: this.cwd,
        env: this.env,
        spawnImpl: this.spawnImpl,
        onExit: current => {
          if (this.workers.get(key) === current) this.workers.delete(key);
        },
      }).start();
      this.workers.set(key, worker);
    }
    return worker;
  }

  async call(name, args = {}, options = {}) {
    const worker = this.workerFor(args);
    const response = await worker.request(name, args, options);
    if (response.error) {
      const error = new Error(response.error.message || `route worker call failed: ${name}`);
      error.code = response.error.code || "ROUTE_WORKER_CALL_FAILED";
      throw error;
    }
    return response.result;
  }

  status() {
    return {
      count: this.workers.size,
      workers: [...this.workers.values()].map(publicWorker),
      isolation: "one MCP worker process per Codex host context",
    };
  }

  closeAll() {
    for (const worker of this.workers.values()) worker.close();
    this.workers.clear();
  }
}

export function createRouteWorkerPool(options = {}) {
  return new RouteWorkerPool(options);
}

export { hostKeyOf };
