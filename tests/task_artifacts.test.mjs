import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureTaskArtifactBaseline,
  collectTaskArtifactCandidates,
  parsePorcelainStatus,
  taskArtifactDeliveryKey,
  taskArtifactPathPolicy,
  undispatchedTaskArtifacts,
} from "../src/bridge/task_artifacts.mjs";

function fixtureRoot() {
  const root = path.join(os.tmpdir(), `codex-bridge-task-artifacts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "preexisting.md"), "old local work", "utf8");
  fs.writeFileSync(path.join(root, "src", "task.js"), "export const task = true;", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE=value", "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "bundle.js"), "ignored", "utf8");
  return root;
}

function fakeGit(root, statuses) {
  let index = 0;
  return async (_command, args) => {
    if (args[0] === "rev-parse") return { stdout: `${root}\n` };
    if (args[0] === "status") return { stdout: statuses[Math.min(index++, statuses.length - 1)] || "" };
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

test("porcelain parser preserves current rename destination and normal paths", () => {
  const entries = parsePorcelainStatus("R  src/new-name.js\u0000src/old-name.js\u0000?? docs/result.md\u0000");
  assert.deepEqual(entries.map(entry => entry.relative_path), ["src/new-name.js", "docs/result.md"]);
  assert.equal(entries[0].deleted, false);
});

test("task-artifact baseline excludes pre-existing work and sensitive/generated paths", async () => {
  const root = fixtureRoot();
  const git = fakeGit(root, [
    " M preexisting.md\u0000",
    " M preexisting.md\u0000 M src/task.js\u0000?? .env\u0000?? node_modules/ignored/bundle.js\u0000",
  ]);
  const baseline = await captureTaskArtifactBaseline({ cwd: root, execFileImpl: git });
  const discovered = await collectTaskArtifactCandidates({ baseline, execFileImpl: git });

  assert.equal(baseline.state, "ready");
  assert.deepEqual(baseline.preexisting_paths, ["preexisting.md"]);
  assert.equal(discovered.state, "ready");
  assert.deepEqual(discovered.files.map(file => file.relative_path), ["src/task.js"]);
  assert.deepEqual(
    discovered.skipped.map(file => [file.relative_path, file.reason]).sort(),
    [[".env", "sensitive_path"], ["node_modules/ignored/bundle.js", "excluded_directory"], ["preexisting.md", "preexisting_change"]],
  );
});

test("artifact paths reject traversal, credentials, and bridge-generated archives", () => {
  assert.equal(taskArtifactPathPolicy("../outside.txt").allowed, false);
  assert.equal(taskArtifactPathPolicy(".env.production").reason, "sensitive_path");
  assert.equal(taskArtifactPathPolicy("certs/release.pem").reason, "sensitive_path");
  assert.equal(taskArtifactPathPolicy(".codex-bridge/attachments/old.zip").reason, "excluded_directory");
  assert.equal(taskArtifactPathPolicy("docs/evidence.md").allowed, true);
});

test("unchanged artifact hashes are not attached again, changed hashes are eligible", () => {
  const first = { relative_path: "src/task.js", sha256: "a".repeat(64) };
  const changed = { relative_path: "src/task.js", sha256: "b".repeat(64) };
  const delivered = { "src/task.js": taskArtifactDeliveryKey(first) };
  assert.deepEqual(undispatchedTaskArtifacts([first], delivered), []);
  assert.deepEqual(undispatchedTaskArtifacts([changed], delivered), [changed]);
});
