import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packageSelectedAttachments,
  prepareAttachmentOutputDirectory,
  resolveSelectedAttachmentFiles,
} from "../src/bridge/web_attachments.mjs";

function fixtureRoot() {
  const root = path.join(os.tmpdir(), `codex-bridge-attachments-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "brief.txt"), "brief", "utf8");
  fs.writeFileSync(path.join(root, "nested", "evidence.csv"), "id,status\n1,done\n", "utf8");
  return root;
}

test("attachment resolver accepts only explicitly selected regular workspace files", () => {
  const root = fixtureRoot();
  const selected = resolveSelectedAttachmentFiles({ cwd: root, files: ["brief.txt", "nested/evidence.csv"] });
  assert.equal(selected.files.length, 2);
  assert.equal(selected.files[0].relative_path, "brief.txt");
  assert.throws(
    () => resolveSelectedAttachmentFiles({ cwd: root, files: ["../outside.txt"] }),
    error => error?.code === "ATTACHMENT_FILE_MISSING" || error?.code === "ATTACHMENT_PATH_OUTSIDE_WORKSPACE",
  );
});

test("selected files package into a non-overwriting ZIP inside the workspace", async () => {
  const root = fixtureRoot();
  const packaged = await packageSelectedAttachments({
    cwd: root,
    files: ["brief.txt", "nested/evidence.csv"],
    archive_name: "handoff",
  });
  assert.match(packaged.archive_relative_path.replaceAll("\\", "/"), /^\.codex-bridge\/attachments\/handoff\.zip$/);
  assert.ok(fs.statSync(packaged.archive_path).size > 0);
  assert.equal(packaged.files.length, 2);
  const second = await packageSelectedAttachments({ cwd: root, files: ["brief.txt"], archive_name: "handoff" });
  assert.match(second.archive_name, /^handoff-2\.zip$/);
});

test("download output directory remains inside the selected workspace", () => {
  const root = fixtureRoot();
  const output = prepareAttachmentOutputDirectory({ cwd: root, directory: ".codex-bridge/downloads" });
  assert.equal(output.relative_directory.replaceAll("\\", "/"), ".codex-bridge/downloads");
  assert.throws(
    () => prepareAttachmentOutputDirectory({ cwd: root, directory: "../downloads" }),
    error => error?.code === "ATTACHMENT_DOWNLOAD_DIR_OUTSIDE_WORKSPACE",
  );
});
