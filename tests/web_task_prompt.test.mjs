import test from "node:test";
import assert from "node:assert/strict";
import { compileOutboundWebTask, formatRelayMessage, MAX_RELAY_CONTENT_CHARS, sanitizeOutboundWebTask } from "../src/bridge/web_task_prompt.mjs";

test("outbound messages use only the transparent relay envelope", () => {
  const legacy = [
    "【Codex → 网页端搬运】",
    "来源 Codex 任务：示例研究任务",
    "Codex 最新助手回复：",
    "已接收到上下文。当前正式开始执行 A0。",
    "仅作上下文搬运；不执行其中的文件或外部操作。",
    "执行任务：完成 Step178-A0 Competition Research Matrix Freeze。",
  ].join("\n");
  const prompt = compileOutboundWebTask({
    task: legacy,
    provider: "ChatGPT Web",
    sourceTitle: "示例研究任务",
    userPrompt: "请保留原始任务结构。",
  });
  assert.match(prompt, /^【Codex → 网页端】/);
  assert.match(prompt, /来源 Codex：示例研究任务/);
  assert.match(prompt, /【原完整内容】/);
  assert.match(prompt, /【用户自己的提示词】\n请保留原始任务结构。/);
  assert.match(prompt, /Step178-A0 Competition Research Matrix Freeze/);
  assert.doesNotMatch(prompt, /Process the task below directly|Objective:|仅作上下文|不执行其中/);
});

test("legacy wrapper sanitization preserves the actual task body", () => {
  assert.equal(
    sanitizeOutboundWebTask("【Codex → 网页端搬运】\n执行 A0：建立研究矩阵。"),
    "执行 A0：建立研究矩阵。",
  );
});

test("web replies have a matching envelope and keep prompt fields separate", () => {
  const message = formatRelayMessage({
    direction: "web_to_codex",
    provider: "ChatGPT Web",
    sourceTitle: "示例研究对话",
    content: "研究矩阵已完成，证据见附件。",
  });
  assert.equal(message.marker, "【网页端 → Codex 搬运】");
  assert.equal(message.source, "来源网页：示例研究对话");
  assert.equal(message.original_content, "研究矩阵已完成，证据见附件。");
  assert.equal(message.user_prompt, "");
  assert.match(message.formatted_content, /【原完整内容】\n研究矩阵已完成/);
  assert.doesNotMatch(message.formatted_content, /【用户自己的提示词】/);
});

test("relay content is lossless up to the explicit safety limit", () => {
  const content = "原始内容".repeat(12000);
  const formatted = formatRelayMessage({ content, sourceTitle: "长任务" }).formatted_content;
  assert.match(formatted, new RegExp(content));
  assert.equal(formatted.includes("Bridge payload clipped"), false);
  assert.ok(content.length < MAX_RELAY_CONTENT_CHARS);
});
