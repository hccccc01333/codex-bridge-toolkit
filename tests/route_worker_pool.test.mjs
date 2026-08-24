import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRouteWorkerPool } from "../src/control_plane/route_worker_pool.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("route worker pool gives independent Codex host contexts independent processes", async () => {
  const pool = createRouteWorkerPool({
    script: path.join(repoRoot, "tests", "route_worker_echo.mjs"),
    cwd: repoRoot,
    env: process.env,
  });
  try {
    const [alpha, beta] = await Promise.all([
      pool.call("bridge_status", { __host_codex_context: { thread_id: "codex-alpha" } }),
      pool.call("bridge_status", { __host_codex_context: { thread_id: "codex-beta" } }),
    ]);
    assert.equal(alpha.structuredContent, undefined);
    assert.equal(alpha.worker_thread, "codex-alpha");
    assert.equal(beta.worker_thread, "codex-beta");
    assert.notEqual(alpha.pid, beta.pid);
    assert.equal(pool.status().count, 2);
    assert.deepEqual(pool.status().workers.map(worker => worker.state).sort(), ["ready", "ready"]);
  } finally {
    pool.closeAll();
  }
});
