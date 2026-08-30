import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile as nativeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nativeExecFile);
export const MAX_ATTACHMENT_FILES = 100;
export const MAX_ATTACHMENT_TOTAL_BYTES = 500 * 1024 * 1024;

function bridgeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function containedIn(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function archiveBaseName(value) {
  const name = String(value || "codex-web-attachments").trim();
  if (!name || name.length > 120 || /[\\/:*?"<>|\u0000-\u001F]/.test(name)) {
    throw bridgeError("archive_name must be a short filename without path characters", "ATTACHMENT_ARCHIVE_NAME_INVALID");
  }
  return name.toLowerCase().endsWith(".zip") ? name : `${name}.zip`;
}

function nextAvailablePath(directory, filename) {
  const parsed = path.parse(filename);
  let index = 1;
  let candidate = path.join(directory, filename);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext || ".zip"}`);
  }
  return candidate;
}

export function resolveSelectedAttachmentFiles({ cwd = process.cwd(), files = [], maxFiles = MAX_ATTACHMENT_FILES, maxTotalBytes = MAX_ATTACHMENT_TOTAL_BYTES } = {}) {
  const root = path.resolve(String(cwd || process.cwd()));
  let rootReal;
  try { rootReal = fs.realpathSync(root); }
  catch { throw bridgeError("attachment workspace does not exist", "ATTACHMENT_WORKSPACE_MISSING"); }
  if (!Array.isArray(files) || !files.length) {
    throw bridgeError("files must contain at least one explicitly selected workspace file", "ATTACHMENT_FILES_REQUIRED");
  }
  if (files.length > maxFiles) {
    throw bridgeError(`at most ${maxFiles} files can be attached at once`, "ATTACHMENT_FILE_LIMIT");
  }
  const selected = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of files) {
    const requested = String(raw || "").trim();
    if (!requested) throw bridgeError("attachment paths must be non-empty", "ATTACHMENT_PATH_INVALID");
    const absolute = path.resolve(root, requested);
    let real;
    let stat;
    try {
      real = fs.realpathSync(absolute);
      stat = fs.statSync(real);
    } catch {
      throw bridgeError(`selected attachment does not exist: ${requested}`, "ATTACHMENT_FILE_MISSING");
    }
    if (!containedIn(rootReal, real)) {
      throw bridgeError(`selected attachment is outside the workspace: ${requested}`, "ATTACHMENT_PATH_OUTSIDE_WORKSPACE");
    }
    if (!stat.isFile()) {
      throw bridgeError(`selected attachment is not a regular file: ${requested}`, "ATTACHMENT_NOT_A_FILE");
    }
    if (seen.has(real)) continue;
    totalBytes += stat.size;
    if (totalBytes > maxTotalBytes) {
      throw bridgeError(`selected attachments exceed the ${maxTotalBytes} byte safety limit`, "ATTACHMENT_TOTAL_TOO_LARGE");
    }
    seen.add(real);
    selected.push({
      absolute_path: real,
      relative_path: path.relative(rootReal, real),
      name: path.basename(real),
      bytes: stat.size,
    });
  }
  return { workspace_root: rootReal, files: selected, total_bytes: totalBytes };
}

export function prepareAttachmentOutputDirectory({ cwd = process.cwd(), directory = ".codex-bridge/downloads" } = {}) {
  const root = path.resolve(String(cwd || process.cwd()));
  let rootReal;
  try { rootReal = fs.realpathSync(root); }
  catch { throw bridgeError("attachment workspace does not exist", "ATTACHMENT_WORKSPACE_MISSING"); }
  const requested = String(directory || ".codex-bridge/downloads").trim();
  if (!requested || path.isAbsolute(requested)) {
    throw bridgeError("download_dir must be a relative directory inside the workspace", "ATTACHMENT_DOWNLOAD_DIR_INVALID");
  }
  const output = path.resolve(rootReal, requested);
  const relative = path.relative(rootReal, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw bridgeError("download_dir must stay inside the workspace", "ATTACHMENT_DOWNLOAD_DIR_OUTSIDE_WORKSPACE");
  }
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  if (!containedIn(rootReal, outputReal)) {
    throw bridgeError("download_dir resolves outside the workspace", "ATTACHMENT_DOWNLOAD_DIR_OUTSIDE_WORKSPACE");
  }
  return { workspace_root: rootReal, output_directory: outputReal, relative_directory: path.relative(rootReal, outputReal) };
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function packageSelectedAttachments({ cwd = process.cwd(), files = [], archive_name, maxFiles, maxTotalBytes } = {}) {
  const selected = resolveSelectedAttachmentFiles({ cwd, files, maxFiles, maxTotalBytes });
  const outputDirectory = path.join(selected.workspace_root, ".codex-bridge", "attachments");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const archivePath = nextAvailablePath(outputDirectory, archiveBaseName(archive_name));
  try {
    // Windows 10/11 and modern macOS/Linux ship tar. Passing only verified
    // relative names after -C prevents a selected path from escaping cwd.
    await execFile("tar", ["--force-local", "-a", "-c", "-f", archivePath, "-C", selected.workspace_root, ...selected.files.map(file => file.relative_path)], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw bridgeError(`could not create ZIP archive with the local tar command: ${String(error?.stderr || error?.message || error)}`, "ATTACHMENT_ARCHIVE_CREATE_FAILED");
  }
  let stat;
  try { stat = fs.statSync(archivePath); }
  catch { throw bridgeError("ZIP archive was not created", "ATTACHMENT_ARCHIVE_MISSING"); }
  if (!stat.isFile() || stat.size === 0) {
    throw bridgeError("ZIP archive is empty or invalid", "ATTACHMENT_ARCHIVE_INVALID");
  }
  return {
    workspace_root: selected.workspace_root,
    archive_path: archivePath,
    archive_relative_path: path.relative(selected.workspace_root, archivePath),
    archive_name: path.basename(archivePath),
    archive_bytes: stat.size,
    archive_sha256: await sha256File(archivePath),
    files: selected.files,
    total_source_bytes: selected.total_bytes,
  };
}
