import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".codex",
  ".next",
  ".turbo",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tmp",
]);

const ARTIFACT_KINDS = Object.freeze({
  ".docx": "word",
  ".pptx": "powerpoint",
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".csv": "csv",
  ".xlsx": "spreadsheet",
});

const TEXT_CONTENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv"]);
const DEFAULT_MAX_TOTAL_CHARS = 20000;
const DEFAULT_MAX_FILE_CHARS = 8000;

function text(value) {
  return String(value ?? "").trim();
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function publicPath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || path.basename(filePath);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function clipText(value, limit) {
  const content = String(value ?? "");
  if (content.length <= limit) return { text: content, clipped: false, original_chars: content.length };
  const head = Math.ceil(limit * 0.65);
  const tail = Math.max(0, limit - head);
  return {
    text: `${content.slice(0, head)}\n\n[…内容已按安全上限截断…]\n\n${tail ? content.slice(-tail) : ""}`,
    clipped: true,
    original_chars: content.length,
  };
}

async function walk(root, maxDepth, maxFiles) {
  const files = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && files.length < maxFiles) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          queue.push({ directory: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const kind = ARTIFACT_KINDS[extension];
      if (!kind) continue;
      try {
        const stat = await fs.stat(absolute);
        files.push({
          name: entry.name,
          relative_path: publicPath(root, absolute),
          kind,
          extension,
          bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        });
      } catch {
        // A file can disappear during a scan. Keep the status useful and safe.
      }
    }
  }
  return files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

export async function inspectArtifactWorkspace({ cwd = process.cwd(), max_depth = 4, max_files = 200 } = {}) {
  const requestedCwd = text(cwd) || process.cwd();
  let root;
  try {
    root = await fs.realpath(requestedCwd);
  } catch (error) {
    return {
      ok: false,
      state: "workspace_unavailable",
      cwd: requestedCwd,
      message: `本地工作区不可读取：${String(error)}`,
      read_only: true,
    };
  }
  const files = await walk(root, boundedNumber(max_depth, 4, 0, 8), boundedNumber(max_files, 200, 1, 500));
  const counts = files.reduce((result, file) => {
    result[file.kind] = (result[file.kind] || 0) + 1;
    return result;
  }, {});
  return {
    ok: true,
    state: files.length ? "artifacts_found" : "no_supported_artifacts",
    read_only: true,
    privacy: "只返回文件名和元数据，不读取文档正文，不上传文件",
    workspace: {
      root,
      name: path.basename(root),
    },
    counts,
    truncated: files.length >= boundedNumber(max_files, 200, 1, 500),
    artifacts: files,
    integrations: {
      word: { discovered: Boolean(counts.word), status: "metadata_only", content_adapter: false },
      powerpoint: { discovered: Boolean(counts.powerpoint), status: "metadata_only", content_adapter: false },
      pdf: { discovered: Boolean(counts.pdf), status: "metadata_only", content_adapter: false },
      notion: { discovered: false, status: "url_reference_only", api_adapter: false },
    },
    next_safe_actions: [
      "让 Codex 明确选择需要读取或编辑的文件",
      "使用对应的文档或演示工具完成内容操作并验证产物",
      "需要 Notion 时由用户提供并确认具体连接方式；本工具不会自动登录或抓取 Notion",
    ],
    checked_at: new Date().toISOString(),
  };
}

export async function readArtifactContext({ cwd = process.cwd(), files = [], max_total_chars = DEFAULT_MAX_TOTAL_CHARS, max_file_chars = DEFAULT_MAX_FILE_CHARS } = {}) {
  const requestedCwd = text(cwd) || process.cwd();
  let root;
  try {
    root = await fs.realpath(requestedCwd);
  } catch (error) {
    return {
      ok: false,
      state: "workspace_unavailable",
      cwd: requestedCwd,
      message: `本地工作区不可读取：${String(error)}`,
      read_only: true,
    };
  }
  const requestedFiles = Array.isArray(files) ? files.map(text).filter(Boolean).slice(0, 20) : [];
  if (!requestedFiles.length) {
    return {
      ok: false,
      state: "file_selection_required",
      workspace: { root, name: path.basename(root) },
      message: "请提供扫描结果中的相对文件路径；不会自动读取整个工作区。",
      read_only: true,
    };
  }
  const totalLimit = boundedNumber(max_total_chars, DEFAULT_MAX_TOTAL_CHARS, 1000, 50000);
  const fileLimit = boundedNumber(max_file_chars, DEFAULT_MAX_FILE_CHARS, 500, 20000);
  const items = [];
  let totalChars = 0;
  for (const requested of requestedFiles) {
    const candidate = path.resolve(root, requested);
    if (!isInside(root, candidate)) {
      items.push({ requested_path: requested, ok: false, state: "path_outside_workspace", message: "路径必须位于当前工作区内。" });
      continue;
    }
    let filePath;
    let stat;
    try {
      filePath = await fs.realpath(candidate);
      stat = await fs.stat(filePath);
    } catch (error) {
      items.push({ requested_path: requested, ok: false, state: "file_unavailable", message: `文件不可读取：${String(error)}` });
      continue;
    }
    if (!isInside(root, filePath)) {
      items.push({ requested_path: requested, ok: false, state: "path_outside_workspace", message: "解析后的文件路径不在当前工作区内。" });
      continue;
    }
    const relativePath = publicPath(root, filePath);
    const extension = path.extname(filePath).toLowerCase();
    const kind = ARTIFACT_KINDS[extension] || "unknown";
    const item = {
      requested_path: requested,
      relative_path: relativePath,
      name: path.basename(filePath),
      kind,
      extension,
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
    if (!TEXT_CONTENT_EXTENSIONS.has(extension)) {
      items.push({
        ...item,
        ok: false,
        state: "content_adapter_unavailable",
        message: kind === "unknown"
          ? "此文件类型没有安全的文本读取适配器。"
          : `${kind} 当前仅支持元数据；正文适配器尚未加入。`,
      });
      continue;
    }
    if (totalChars >= totalLimit) {
      items.push({ ...item, ok: false, state: "context_limit_reached", message: "已达到本次读取的总字符上限。" });
      continue;
    }
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const allowed = Math.min(fileLimit, totalLimit - totalChars);
      const clipped = clipText(raw, allowed);
      totalChars += clipped.text.length;
      items.push({ ...item, ok: true, state: "content_read", content: clipped.text, clipped: clipped.clipped, original_chars: clipped.original_chars });
    } catch (error) {
      items.push({ ...item, ok: false, state: "content_read_failed", message: `文本读取失败：${String(error)}` });
    }
  }
  const readable = items.filter(item => item.state === "content_read").length;
  return {
    ok: readable > 0,
    state: readable > 0 ? "content_available" : "no_content_adapter_available",
    read_only: true,
    privacy: "只读取用户明确选择的工作区内文本文件；不上传、不登录外部服务、不自动读取整个工作区",
    workspace: { root, name: path.basename(root) },
    limits: { max_total_chars: totalLimit, max_file_chars: fileLimit, selected_files: requestedFiles.length },
    items,
    content_files: readable,
    next_safe_actions: [
      "把返回的文本作为 Codex 本地上下文使用",
      "对 Word/PPT/PDF 先提供对应内容解析器，不能把二进制原文直接发送给网页端",
      "需要网页大脑审查时，先由用户确认要发送的摘要或片段",
    ],
    checked_at: new Date().toISOString(),
  };
}
