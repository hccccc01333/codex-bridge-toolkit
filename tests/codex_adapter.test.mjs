import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAdapter, codexSpawnSpec, codexThreadIdFromUrl, defaultCodexCommand } from "../src/adapters/codex.mjs";

test("Codex Adapter resolves the Windows CLI launcher without spawning the desktop executable", () => {
  assert.equal(defaultCodexCommand({ platform: "win32", env: {} }), "codex.cmd");
  assert.equal(defaultCodexCommand({ platform: "linux", env: {} }), "codex");
  assert.equal(defaultCodexCommand({ platform: "win32", env: { CODEX_BRIDGE_CODEX_COMMAND: "D:\\tools\\codex.cmd" } }), "D:\\tools\\codex.cmd");
  assert.deepEqual(codexSpawnSpec("C:\\Program Files\\codex.cmd", ["app-server"], { platform: "win32", env: { ComSpec: "cmd.exe" } }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\Program Files\\codex.cmd" app-server'],
    options: {},
  });
  assert.deepEqual(codexSpawnSpec("codex.ps1", ["app-server"], { platform: "win32" }), {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "codex.ps1", "app-server"],
    options: {},
  });
});

test("Codex source thread URLs are parsed explicitly and reject ordinary URLs", () => {
  const id = "01a0331b-f45f-7bd0-861f-e2e491e43328";
  assert.equal(codexThreadIdFromUrl(`codex://threads/${id}`), id);
  assert.equal(codexThreadIdFromUrl(`codex://threads/${id}/extra`), null);
  assert.equal(codexThreadIdFromUrl(`https://chatgpt.com/c/${id}`), null);
});

class FakeCodexProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.stdin.write = chunk => {
      const message = JSON.parse(String(chunk).trim());
      if (message.method === "initialize") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2" } });
      } else if (message.method === "thread/start") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-test" } } });
      } else if (message.method === "turn/start") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-test", status: "inProgress" } } });
        setTimeout(() => {
          this.reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: {
            threadId: message.params.threadId, turnId: "turn-test", itemId: "item-test", delta: "done",
          } });
          this.reply({ jsonrpc: "2.0", method: "turn/completed", params: {
            threadId: message.params.threadId, turn: { id: "turn-test", status: "completed" },
          } });
        }, 5);
      } else if (message.method === "thread/read") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
      } else if (message.method === "thread/goal/set") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: {
          goal: {
            threadId: message.params.threadId,
            objective: message.params.objective,
            status: message.params.status,
            tokenBudget: message.params.tokenBudget || null,
          },
        } });
      } else if (message.method === "thread/goal/get") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { goal: { threadId: message.params.threadId, status: "active" } } });
      } else if (message.method === "thread/goal/clear") {
        this.reply({ jsonrpc: "2.0", id: message.id, result: { cleared: true } });
      }
      return true;
    };
  }

  reply(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    this.emit("exit", 0, null);
  }
}

test("Codex Adapter starts a thread and completes a turn through app-server protocol", async () => {
  const adapter = new CodexAdapter({ spawnImpl: () => new FakeCodexProcess(), timeoutMs: 1000 });
  const thread = await adapter.startThread({ cwd: process.cwd() });
  assert.equal(thread.thread_id, "thread-test");
  const result = await adapter.sendTask({ thread_id: thread.thread_id, text: "run the task" });
  assert.equal(result.completed, true);
  assert.equal(result.thread_id, "thread-test");
  assert.equal(result.text, "done");
  assert.equal(adapter.status().state, "ready");
  adapter.close();
});

test("Codex Adapter writes and reads a native thread goal through app-server", async () => {
  const adapter = new CodexAdapter({ spawnImpl: () => new FakeCodexProcess(), timeoutMs: 1000 });
  const thread = await adapter.startThread({ cwd: process.cwd() });
  const set = await adapter.setThreadGoal({
    thread_id: thread.thread_id,
    objective: "完成迁移并保留测试证据",
    status: "active",
    tokenBudget: 40000,
  });
  assert.equal(set.goal.threadId, "thread-test");
  assert.equal(set.goal.objective, "完成迁移并保留测试证据");
  assert.equal(set.goal.tokenBudget, 40000);
  const read = await adapter.getThreadGoal(thread.thread_id);
  assert.equal(read.goal.threadId, "thread-test");
  const cleared = await adapter.clearThreadGoal(thread.thread_id);
  assert.equal(cleared.cleared, true);
  await assert.rejects(
    adapter.setThreadGoal({ thread_id: thread.thread_id, objective: "x".repeat(4001) }),
    /at most 4000 characters/,
  );
  adapter.close();
});

test("Codex Adapter reports an explicit unavailable error instead of fabricating a worker", async () => {
  const adapter = new CodexAdapter({
    spawnImpl: () => { throw new Error("app-server missing"); },
  });
  await assert.rejects(
    adapter.startThread(),
    error => error?.code === "CODEX_ADAPTER_UNAVAILABLE",
  );
  assert.equal(adapter.status().state, "unavailable");
});
