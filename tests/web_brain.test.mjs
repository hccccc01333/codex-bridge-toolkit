import test from "node:test";
import assert from "node:assert/strict";
import {
  getBrainProvider,
  listBrainProviders,
  normalizeBrainProvider,
  providerMatchesUrl,
  selectorHealthScript,
} from "../src/adapters/web_brain.mjs";
import {
  conversationIdFromUrl,
  conversationMatches,
  safeConversationUrl,
} from "../src/browser/conversation_router.mjs";

test("web brain registry exposes ChatGPT as default and DeepSeek as a selectable profile", () => {
  assert.deepEqual(listBrainProviders().map(provider => provider.id), ["chatgpt", "deepseek"]);
  assert.equal(listBrainProviders()[0].selection_hint, "默认通用规划与审查，适合大多数任务。");
  assert.equal(listBrainProviders()[1].selection_hint, "中文推理与成本敏感任务的可选大脑。");
  assert.equal(normalizeBrainProvider("DeepSeek"), "deepseek");
  assert.equal(getBrainProvider("deepseek").start_url, "https://chat.deepseek.com/");
  assert.equal(providerMatchesUrl("deepseek", "https://chat.deepseek.com/"), true);
  assert.equal(providerMatchesUrl("deepseek", "https://chatgpt.com/"), false);
});

test("DeepSeek conversation URLs stay provider-scoped", () => {
  const id = "abcdef12-3456-7890";
  const url = `https://chat.deepseek.com/a/chat/s/${id}`;
  assert.equal(conversationIdFromUrl(url, "deepseek"), id);
  assert.equal(safeConversationUrl(id, "deepseek"), url);
  assert.equal(conversationMatches({ expectedId: id, actualUrl: url, provider: "deepseek" }), true);
  assert.equal(safeConversationUrl("https://chatgpt.com/c/not-deepseek", "deepseek"), null);
});

test("provider health scripts use provider-specific selectors", () => {
  const script = selectorHealthScript("deepseek");
  assert.ok(script.includes("chat.deepseek.com") === false);
  assert.ok(script.includes("textarea:not([disabled])"));
  assert.ok(script.includes("submit"));
  assert.ok(script.includes("deepseek"));
});
