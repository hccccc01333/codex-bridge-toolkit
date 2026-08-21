import test from "node:test";
import assert from "node:assert/strict";
import { getWebLLMAdapter, listWebLLMAdapters } from "../src/adapters/provider_registry.mjs";

test("web LLM adapters expose provider-specific boundaries", () => {
  assert.deepEqual(listWebLLMAdapters().map(adapter => adapter.id), ["chatgpt", "deepseek"]);
  const chatgpt = getWebLLMAdapter("chatgpt");
  const deepseek = getWebLLMAdapter("deepseek");
  assert.equal(chatgpt.detect("https://chatgpt.com/c/abc"), true);
  assert.equal(chatgpt.detect("https://chat.deepseek.com/a/chat/s-1"), false);
  assert.equal(deepseek.detect("https://chat.deepseek.com/a/chat/s-1"), true);
  assert.deepEqual(chatgpt.getConversationFingerprint({ id: "c1", title: "Research", url: "https://chatgpt.com/c/c1" }), {
    provider: "chatgpt", id: "c1", title: "Research", url: "https://chatgpt.com/c/c1",
  });
  for (const method of ["listConversations", "selectConversation", "findComposer", "findSendControl", "isGenerating", "getLatestAssistantMessage", "stopGeneration"]) {
    assert.equal(typeof chatgpt[method], "function", `${method} should be part of the adapter boundary`);
  }
  assert.equal(chatgpt.isLoggedIn({ loginRequired: true }), false);
  assert.equal(deepseek.isLoggedIn({ loginRequired: false }), true);
  assert.match(deepseek.selectorHealthScript(), /provider: "deepseek"/);
});
