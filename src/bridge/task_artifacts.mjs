import fs from "node:fs";
import path from "node:path";
import { execFile as nativeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nativeExecFile);

export const TASK_ARTIFACT_BASELINE_VERSION = 1;

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".codex-bridge",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".gitconfig",
  "credentials",
  "credential",
  "secrets",
  "secret",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".kdbx",
]);

function text(value) {
  return String(value ?? "").trim();
}

function artifactError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRelativePath(value) {
  const raw = text(value).replaceAll("\\", "/");
  if (!raw || raw.includes("\u0000") || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function pathSegments(relativePath) {
  return relativePath.split("/").map(segment => segment.toLowerCase());
}

export function taskArtifactPathPolicy(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return { allowed: false, reason: "invalid_path", relative_path: null };
  const segments = pathSegments(normalized);
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) {
    return { allowed: false, reason: "excluded_directory", relative_path: normalized };
  }
  const basename = segments.at(-1);
  const extension = path.posix.extname(basename);
  if (basename.startsWith(".env") || SENSITIVE_BASENAMES.has(basename) || SENSITIVE_EXTENSIONS.has(extension)) {
    return { allowed: false, reason: "sensitive_path", relative_path: normalized };
  }
  if (/(?:^|[-_.])(secret|credential|password|token|private)(?:[-_.]|$)/i.test(basename)) {
    return { allowed: false, reason: "sensitive_path", relative_path: normalized };
  }
  return { allowed: true, reason: null, relative_path: normalized };
}

export function parsePorcelainStatus(output = "") {
  const fields = String(output || "").split("\u0000");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const raw = fields[index];
    if (!raw || raw.length < 4) continue;
    const code = raw.slice(0, 2);
    const candidate = normalizeRelativePath(raw.slice(3));
    const renamedOrCopied = /[RC]/.test(code);
    if (renamedOrCopied && index + 1 < fields.length) index += 1;
    if (!candidate) continue;
    entries.push({
      code,
      relative_path: candidate,
      deleted: code.includes("D"),
    });
  }
  return entries;
}

async function gitStatus(cwd, execFileImpl = execFile) {
  const result = await execFileImpl("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePorcelainStatus(result?.stdout || "");
}

async function gitRoot(cwd, execFileImpl = execFile) {
  const result = await execFileImpl("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return text(result?.stdout);
}

export async function captureTaskArtifactBaseline({ cwd = process.cwd(), execFileImpl = execFile } = {}) {
  const requested = path.resolve(String(cwd || process.cwd()));
  try {
    const root = await gitRoot(requested, execFileImpl);
    const workspaceRoot = fs.realpathSync(root);
    const entries = await gitStatus(workspaceRoot, execFileImpl);
    return {
      version: TASK_ARTIFACT_BASELINE_VERSION,
      state: "ready",
      workspace_root: workspaceRoot,
      captured_at: new Date().toISOString(),
      preexisting_paths: [...new Set(entries.map(entry => entry.relative_path))].sort(),
      preexisting_count: entries.length,
    };
  } catch (error) {
    return {
      version: TASK_ARTIFACT_BASELINE_VERSION,
      state: "unavailable",
      workspace_root: null,
      captured_at: new Date().toISOString(),
      preexisting_paths: [],
      preexisting_count: 0,
      reason: String(error?.stderr || error?.message || error),
    };
  }
}

export async function collectTaskArtifactCandidates({ baseline, delivered = {}, execFileImpl = execFile } = {}) {
  if (!baseline || baseline.state !== "ready" || !baseline.workspace_root) {
    return {
      state: "unavailable",
      files: [],
      skipped: [],
      reason: baseline?.reason || "a Git task-artifact baseline was not captured for this bridge goal",
    };
  }
  let root;
  try {
    root = fs.realpathSync(baseline.workspace_root);
  } catch {
    return { state: "unavailable", files: [], skipped: [], reason: "the baseline workspace is no longer available" };
  }
  let entries;
  try {
    entries = await gitStatus(root, execFileImpl);
  } catch (error) {
    return { state: "unavailable", files: [], skipped: [], reason: String(error?.stderr || error?.message || error) };
  }
  const preexisting = new Set(Array.isArray(baseline.preexisting_paths) ? baseline.preexisting_paths : []);
  const candidates = [];
  const skipped = [];
  for (const entry of entries) {
    if (preexisting.has(entry.relative_path)) {
      skipped.push({ relative_path: entry.relative_path, reason: "preexisting_change" });
      continue;
    }
    if (entry.deleted) {
      skipped.push({ relative_path: entry.relative_path, reason: "deleted" });
      continue;
    }
    const policy = taskArtifactPathPolicy(entry.relative_path);
    if (!policy.allowed) {
      skipped.push({ relative_path: entry.relative_path, reason: policy.reason });
      continue;
    }
    const absolute = path.resolve(root, policy.relative_path);
    let stat;
    try { stat = fs.statSync(absolute); }
    catch {
      skipped.push({ relative_path: policy.relative_path, reason: "missing" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ relative_path: policy.relative_path, reason: "not_regular_file" });
      continue;
    }
    candidates.push({
      relative_path: policy.relative_path,
      code: entry.code,
      already_delivered: Boolean(delivered?.[policy.relative_path]),
    });
  }
  return {
    state: "ready",
    workspace_root: root,
    files: candidates,
    skipped,
    current_change_count: entries.length,
  };
}

export function taskArtifactDeliveryKey({ relative_path, sha256 }) {
  const relative = normalizeRelativePath(relative_path);
  const digest = text(sha256).toLowerCase();
  if (!relative || !/^[a-f0-9]{64}$/.test(digest)) {
    throw artifactError("task artifact delivery key requires a relative path and SHA-256", "TASK_ARTIFACT_KEY_INVALID");
  }
  return `${relative}:${digest}`;
}

export function undispatchedTaskArtifacts(files = [], delivered = {}) {
  const sent = new Set(Object.values(delivered || {}).map(value => String(value || "")));
  return files.filter(file => !sent.has(taskArtifactDeliveryKey(file)));
}
