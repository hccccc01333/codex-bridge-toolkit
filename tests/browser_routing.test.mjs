import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationIdFromUrl,
  conversationMatches,
  safeConversationUrl,
} from "../src/browser/conversation_router.mjs";

test("T9 conversation routing rejects a wrong conversation id", () => {
  const expected = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(conversationIdFromUrl(`https://chatgpt.com/c/${expected}`), expected);
  assert.equal(conversationMatches({ expectedId: expected, actualUrl: "https://chatgpt.com/c/wrong-id" }), false);
  assert.equal(conversationMatches({ expectedId: expected, actualUrl: `https://chatgpt.com/c/${expected}` }), true);
  assert.equal(safeConversationUrl(expected), `https://chatgpt.com/c/${expected}`);
  assert.equal(safeConversationUrl("https://example.com/c/not-chatgpt"), null);
});

test("ChatGPT custom GPT conversation URLs keep the conversation id", () => {
  const id = "6a850a8a-8184-83ec-8d1e-52ce9532e7a6";
  const url = `https://chatgpt.com/g/g-p-6a8b1083979c8191b010ccb690f538ee/c/${id}`;
  assert.equal(conversationIdFromUrl(url), id);
  assert.equal(safeConversationUrl(url), url);
  assert.equal(conversationMatches({ expectedId: id, actualUrl: url }), true);
  assert.equal(conversationMatches({ expectedId: id, actualUrl: url.replace(id, "wrong") }), false);
});
