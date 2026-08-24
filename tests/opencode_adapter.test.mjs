import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../src/adapters/opencode.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() { return body === "" ? "" : JSON.stringify(body); },
  };
}

test("OpenCode adapter connects, creates a session, sends a task, and reads messages", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    endpoint: "http://127.0.0.1:4096/",
    model: "openai/gpt-5",
    agent: "build",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/global/health")) return response({ healthy: true, version: "test" });
      if (url.endsWith("/session") && options.method === "POST") return response({ id: "ses_test" });
      if (url.includes("/session/ses_test/message") && options.method === "POST") {
        return response({ info: { id: "msg_test" }, parts: [{ type: "text", text: "已完成测试" }] });
      }
      if (url.includes("/session/ses_test/message?limit=20")) return response([{ info: { id: "msg_test" }, parts: [{ type: "text", text: "已完成测试" }] }]);
      if (url.endsWith("/session/ses_test")) return response({ id: "ses_test", title: "Bridge" });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const started = await adapter.startThread({ title: "OpenCode bridge" });
  assert.equal(started.thread_id, "ses_test");
  const turn = await adapter.sendTask({ thread_id: "ses_test", text: "执行测试" });
  assert.equal(turn.completed, true);
  assert.equal(turn.text, "已完成测试");
  const messages = await adapter.readThread("ses_test");
  assert.equal(messages[0].parts[0].text, "已完成测试");
  assert.equal(calls[0].url, "http://127.0.0.1:4096/global/health");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    parts: [{ type: "text", text: "执行测试" }],
    model: "openai/gpt-5",
    agent: "build",
  });
  assert.equal(adapter.status().native_goal, false);
});

test("OpenCode adapter keeps credentials out of endpoint and uses basic auth from options", async () => {
  const calls = [];
  const adapter = new OpenCodeAdapter({
    endpoint: "http://127.0.0.1:4096",
    username: "opencode-user",
    password: "local-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ healthy: true });
    },
  });
  await adapter.connect();
  assert.equal(adapter.status().endpoint, "http://127.0.0.1:4096");
  assert.match(calls[0].options.headers.authorization, /^Basic /);
  assert.throws(
    () => new OpenCodeAdapter({ endpoint: "http://user:pass@127.0.0.1:4096" }),
    error => error?.code === "OPENCODE_ENDPOINT_CREDENTIALS_FORBIDDEN",
  );
});

test("OpenCode adapter records Bridge Goal locally instead of pretending to support Codex native Goal", async () => {
  const adapter = new OpenCodeAdapter({ fetchImpl: async () => response({ healthy: true }) });
  const result = await adapter.setThreadGoal({ thread_id: "ses_test", objective: "完成任务" });
  assert.equal(result.local_only, true);
  assert.equal(result.method, "bridge_goal");
  assert.equal(result.goal.objective, "完成任务");
});
