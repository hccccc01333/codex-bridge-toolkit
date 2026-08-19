import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAdapter } from "../src/adapters/codex.mjs";

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
