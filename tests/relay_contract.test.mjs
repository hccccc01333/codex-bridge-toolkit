import test from "node:test";
import assert from "node:assert/strict";
import {
  createMessageEnvelope,
  destinationMatches,
  markMessageConsumed,
  normalizeRelayConfig,
  userFacingRelayMode,
  wasMessageConsumed,
} from "../src/bridge/relay_contract.mjs";
import {
  browserInstanceFromEndpoint,
  discoveryText,
  publicBrowserChoices,
  selectTab,
  selectTabInWindow,
  selectWindow,
  undebuggableBrowserInstance,
} from "../src/browser/discovery.mjs";

test("relay modes keep technical IDs out of the user-facing contract", () => {
  assert.deepEqual(normalizeRelayConfig({ mode: "one_shot" }), {
    mode: "one_shot", rounds: 1, manual: false, direction: "codex_to_web", goal: "", goal_source: "none",
  });
  assert.deepEqual(normalizeRelayConfig({ rounds: 0 }), {
    mode: "bounded", rounds: 0, manual: true, direction: "codex_to_web", goal: "", goal_source: "none",
  });
  assert.equal(userFacingRelayMode(normalizeRelayConfig({ rounds: 10, goal_source: "codex_conversation" })), "10 轮往返");
  assert.throws(() => normalizeRelayConfig({ mode: "continuous" }), /requires a goal/);
  assert.equal(normalizeRelayConfig({ mode: "continuous", goal_source: "codex_conversation" }).goal_source, "codex_conversation");
  assert.equal(normalizeRelayConfig({ mode: "continuous", goal_source: "plugin_question" }).goal_source, "plugin_question");
});

test("message envelopes identify origin and consume each message once", () => {
  const envelope = createMessageEnvelope({
    origin: "web_chatgpt",
    provider: "chatgpt",
    conversationId: "conversation-1",
    relayId: "relay-1",
    turnIndex: 2,
    content: "A visible web reply",
  });
  const consumed = new Set();
  assert.equal(envelope.origin, "web_chatgpt");
  assert.match(envelope.message_hash, /^[a-f0-9]{64}$/);
  assert.equal(wasMessageConsumed(envelope, consumed), false);
  markMessageConsumed(envelope, consumed);
  assert.equal(wasMessageConsumed(envelope, consumed), true);
});

test("user-authored relay prompts are stored separately and affect deduplication", () => {
  const base = createMessageEnvelope({
    origin: "codex",
    provider: "chatgpt",
    conversationId: "conversation-a",
    content: "执行 A0",
  });
  const withPrompt = createMessageEnvelope({
    origin: "codex",
    provider: "chatgpt",
    conversationId: "conversation-a",
    content: "执行 A0",
    userPrompt: "只返回证据清单",
  });
  assert.equal(base.original_content, "执行 A0");
  assert.equal(base.user_prompt, "");
  assert.equal(withPrompt.user_prompt, "只返回证据清单");
  assert.notEqual(base.message_hash, withPrompt.message_hash);
});

test("destination verification fails closed when the conversation changes", () => {
  const expected = { provider: "chatgpt", target_id: "tab-1", conversation_id: "conversation-1" };
  assert.equal(destinationMatches(expected, { ...expected }), true);
  assert.equal(destinationMatches(expected, { ...expected, conversation_id: "conversation-2" }), false);
});

test("browser discovery presents tabs by human position and selects without exposing IDs", () => {
  const instance = browserInstanceFromEndpoint({
    port: 9222,
    version: { Browser: "Edg/140.0" },
    targets: [
      { type: "page", id: "secret-a", title: "GitHub", url: "https://github.com", tabStripIndex: 1 },
      { type: "page", id: "secret-b", title: "ChatGPT", url: "https://chatgpt.com/c/1", tabStripIndex: 0 },
    ],
  });
  assert.equal(instance.browser_instance, "Edge 浏览器 1");
  assert.equal(selectTab(instance, "1").title, "ChatGPT");
  assert.match(discoveryText([instance]), /Edge 浏览器 1/);
  assert.doesNotMatch(JSON.stringify(publicBrowserChoices([instance])), /secret-[ab]/);
});

test("browser discovery groups real windows and reports an undebuggable Edge separately", () => {
  const instance = browserInstanceFromEndpoint({
    port: 9222,
    version: { Browser: "Edg/140.0" },
    windowByTarget: { "tab-a": "window-1", "tab-b": "window-2" },
    targets: [
      { type: "page", id: "tab-a", title: "ChatGPT", url: "https://chatgpt.com/c/1" },
      { type: "page", id: "tab-b", title: "DeepSeek", url: "https://chat.deepseek.com/a/chat/s-1" },
    ],
  });
  const undebuggable = undebuggableBrowserInstance({ index: 2, userDataDir: "C:\\private-profile", processId: "123" });
  assert.equal(instance.window_count, 2);
  assert.equal(instance.windows[1].tabs[0].title, "DeepSeek");
  assert.equal(selectWindow(instance, "2").window, "窗口 2");
  assert.equal(selectTabInWindow(instance, "2", "1").title, "DeepSeek");
  assert.equal(undebuggable.debugging, false);
  assert.doesNotMatch(JSON.stringify(publicBrowserChoices([undebuggable])), /private-profile|123/);
  assert.match(discoveryText([undebuggable]), /尚未允许网页连接/);
});
