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
