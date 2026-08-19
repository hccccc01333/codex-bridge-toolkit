import test from "node:test";
import assert from "node:assert/strict";
import { SELECTOR_STRATEGIES, selectorHealthScript } from "../src/browser/selectors.mjs";

test("ChatGPT Web selector adapter exposes ordered fallback strategies", () => {
  const script = selectorHealthScript();
  assert.equal(SELECTOR_STRATEGIES.length, 3);
  assert.ok(script.includes("contenteditable-role"));
  assert.ok(script.includes("enabled-textarea"));
  assert.ok(script.includes("send-button"));
});
