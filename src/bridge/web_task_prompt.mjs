const MAX_TASK_CHARS = 24000;
const MAX_USER_PROMPT_CHARS = 8000;

function clip(value, limit = MAX_TASK_CHARS) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function stripLegacyRelayWrapper(value) {
  let text = String(value ?? "").trim();
  const prefixes = [
    /^【Codex\s*→\s*网页端(?:搬运)?】\s*/u,
    /^来源\s*Codex\s*任务[：:]\s*[^\r\n]*\r?\n?/iu,
    /^Codex\s*最新助手回复[：:]\s*\r?\n?/iu,
    /^已接收到上下文[。.!！]?\s*\r?\n?/u,
    /^仅作上下文(?:搬运)?[；;，,。.!！]*[^\r\n]*\r?\n?/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      const next = text.replace(prefix, "").trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  return text
    .split(/\r?\n/u)
    .filter(line => !/^\s*仅作上下文(?:搬运)?[；;，,。.!！]*[^\r\n]*$/u.test(line))
    .join("\n")
    .trim();
}

export function compileOutboundWebTask({ task, provider = "", sourceTitle = "", userPrompt = "" } = {}) {
  return formatRelayMessage({
    direction: "codex_to_web",
    provider,
    sourceTitle,
    content: task,
    userPrompt,
  }).formatted_content;
}

export function sanitizeOutboundWebTask(value) {
  return clip(stripLegacyRelayWrapper(value));
}

function sourceLine({ direction, sourceTitle = "", provider = "" } = {}) {
  const source = clip(sourceTitle || provider || (direction === "web_to_codex" ? "网页端当前对话" : "当前 Codex 对话"), 240);
  return direction === "web_to_codex"
    ? `来源网页：${source}`
    : `来源 Codex：${source}`;
}

/**
 * Build the intentionally minimal message envelope shown to either side.
 * The bridge owns only routing metadata. It must not invent an instruction
 * for the web model or for Codex; user_prompt is the only optional addition.
 */
export function formatRelayMessage({
  direction = "codex_to_web",
  provider = "",
  sourceTitle = "",
  content = "",
  userPrompt = "",
} = {}) {
  const normalizedDirection = direction === "web_to_codex" ? "web_to_codex" : "codex_to_web";
  const originalContent = clip(stripLegacyRelayWrapper(content));
  const optionalPrompt = clip(userPrompt, MAX_USER_PROMPT_CHARS);
  const marker = normalizedDirection === "web_to_codex"
    ? "【网页端 → Codex 搬运】"
    : "【Codex → 网页端】";
  const sections = [
    marker,
    sourceLine({ direction: normalizedDirection, sourceTitle, provider }),
    "",
    "【原完整内容】",
    originalContent,
  ];
  if (optionalPrompt) sections.push("", "【用户自己的提示词】", optionalPrompt);
  return {
    direction: normalizedDirection,
    marker,
    source: sourceLine({ direction: normalizedDirection, sourceTitle, provider }),
    original_content: originalContent,
    user_prompt: optionalPrompt,
    formatted_content: sections.join("\n"),
  };
}
