import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const testRoot = path.join(os.tmpdir(), "codex-chatgpt-bridge-tests");
process.env.LOCALAPPDATA = path.join(testRoot, "localappdata");
process.env.CODEX_BRIDGE_DB_PATH = path.join(testRoot, "control-plane.sqlite");

const controlPlane = await import(`../scripts/control_plane.mjs?test=${Date.now()}`);
const {
  enqueueRouteAction,
  controlPlaneCapabilities,
  newRouteRecord,
  readWebDelivery,
  removeWebDelivery,
  readRoute,
  routeQueueState,
  updateRoute,
  writeWebDelivery,
  writeRoute,
} = controlPlane;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetRoute(id, fields = {}) {
  return writeRoute(newRouteRecord(id, fields));
}

test("T7 route state remains isolated between sessions", () => {
  resetRoute("test-alpha", { session_id: "session-alpha" });
  resetRoute("test-beta", { session_id: "session-beta" });
  updateRoute("test-alpha", { latest_task: "alpha-only" });
  assert.equal(readRoute("test-alpha").latest_task, "alpha-only");
  assert.equal(readRoute("test-beta").latest_task, null);
  assert.equal(readRoute("test-beta").session_id, "session-beta");
});

test("route metadata preserves the selected brain and executor providers", () => {
  resetRoute("deepseek-route", {
    session_id: "deepseek-session",
    brain_provider: "deepseek",
    executor_provider: "deepseek_api",
    executor_model: "deepseek-v4-flash",
    executor_profile: "my-deepseek",
  });
  assert.equal(readRoute("deepseek-route").brain_provider, "deepseek");
  const summary = controlPlane.routeSummary(readRoute("deepseek-route"));
  assert.equal(summary.brain_provider, "deepseek");
  assert.equal(summary.executor_provider, "deepseek_api");
  assert.equal(summary.executor_model, "deepseek-v4-flash");
  assert.equal(summary.executor_profile, "my-deepseek");
});

test("route metadata preserves the Codex conversation binding source", () => {
  resetRoute("visible-codex-route", {
    codex_thread_id: "visible-thread",
    codex_binding: {
      state: "bound",
      source: "current_codex_conversation",
      title: "当前 Codex 对话",
      verified: true,
    },
  });
  const summary = controlPlane.routeSummary(readRoute("visible-codex-route"));
  assert.equal(summary.codex_thread_id, "visible-thread");
  assert.equal(summary.codex_binding.source, "current_codex_conversation");
  assert.equal(summary.codex_binding.verified, true);
});

test("route status reports whether serialization is cross-process", () => {
  const capabilities = controlPlaneCapabilities();
  const queue = routeQueueState("test-alpha");
  assert.equal(queue.distributed_lock_available, capabilities.distributed_lock);
  assert.equal(capabilities.durable_web_delivery_ledger, capabilities.distributed_lock);
  assert.equal(queue.serialization_scope, capabilities.serialization_scope);
});

test("web delivery records survive a second control-plane process", async () => {
  const deliveryId = `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeWebDelivery(deliveryId, {
    route_id: "delivery-route",
    provider: "chatgpt",
    target_id: "target-test",
    conversation_url: "https://chatgpt.com/c/test",
    state: "unknown",
    prompt_length: 12000,
    original_prompt_length: 24000,
  });
  const worker = path.resolve("tests/delivery_worker.mjs");
  const child = await new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, [worker, deliveryId], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", chunk => { stdout += chunk.toString(); });
    childProcess.stderr.on("data", chunk => { stderr += chunk.toString(); });
    childProcess.on("error", reject);
    childProcess.on("close", code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `worker exited ${code}`)));
  });
  assert.equal(child.delivery_id, deliveryId);
  assert.equal(child.state, "unknown");
  assert.equal(child.original_prompt_length, 24000);
  removeWebDelivery(deliveryId);
  assert.equal(readWebDelivery(deliveryId), null);
});

test("T8 actions for one route are serialized", async () => {
  resetRoute("test-serial", { session_id: "session-serial" });
  const events = [];
  await Promise.all([
    enqueueRouteAction("test-serial", "first", async () => {
      events.push("first-start");
      await delay(25);
      events.push("first-end");
    }),
    enqueueRouteAction("test-serial", "second", async () => {
      events.push("second-start");
      await delay(5);
      events.push("second-end");
    }),
  ]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("T10 paused routes refuse execution", async () => {
  resetRoute("test-paused", { session_id: "session-paused", status: "paused" });
  await assert.rejects(
    enqueueRouteAction("test-paused", "blocked-action", async () => "unreachable"),
    error => error?.code === "ROUTE_PAUSED",
  );
});

test("T8b separate processes share the distributed route lease", async () => {
  const routeId = `cross-process-${Date.now()}`;
  const logPath = path.join(testRoot, `${routeId}.jsonl`);
  resetRoute(routeId, { session_id: `${routeId}-session` });
  const worker = path.resolve("tests/queue_worker.mjs");
  const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, routeId, logPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
  });
  await Promise.all([runWorker(), runWorker()]);
  const records = (await import("node:fs/promises")).readFile(logPath, "utf8")
    .then(text => text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  const entries = await records;
  assert.equal(entries.length, 4);
  const starts = entries.filter(entry => entry.phase === "start").sort((a, b) => a.time - b.time);
  const ends = entries.filter(entry => entry.phase === "end").sort((a, b) => a.time - b.time);
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.ok(starts[1].time >= ends[0].time, "route actions overlapped across processes");
});

after(() => {
  // Test artifacts are intentionally retained for post-run inspection.
});
