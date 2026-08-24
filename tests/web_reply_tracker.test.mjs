import test from "node:test";
import assert from "node:assert/strict";
import {
  WEB_PROMPT_MAX_CHARS,
  compactWebPrompt,
  createReplyTracker,
  observeReply,
} from "../src/bridge/web_reply_tracker.mjs";

test("reply tracker ignores the previous assistant message and waits for a stable new one", () => {
  const tracker = createReplyTracker({ assistant_messages: [{ id: "old", text: "previous" }] }, {
    stablePollsRequired: 3,
    minStableMs: 0,
    now: 0,
  });
  assert.equal(observeReply(tracker, { assistant_messages: [{ id: "old", text: "previous" }] }, 1).done, false);
  assert.equal(observeReply(tracker, { assistant_messages: [{ id: "old", text: "previous" }, { id: "new", text: "现在" }], generating: true }, 2).done, false);
  assert.equal(observeReply(tracker, { assistant_messages: [{ id: "old", text: "previous" }, { id: "new", text: "完整回复" }], generating: false }, 3).done, false);
  assert.equal(observeReply(tracker, { assistant_messages: [{ id: "old", text: "previous" }, { id: "new", text: "完整回复" }], generating: false }, 4).done, false);
  const completed = observeReply(tracker, { assistant_messages: [{ id: "old", text: "previous" }, { id: "new", text: "完整回复" }], generating: false }, 5);
  assert.equal(completed.done, true);
  assert.equal(completed.candidate.text, "完整回复");
});

test("reply tracker does not treat a thinking placeholder as a completed reply", () => {
  const tracker = createReplyTracker({}, { stablePollsRequired: 2, minStableMs: 0, now: 0 });
  const state = observeReply(tracker, { assistant_messages: [{ id: "new", text: "正在思考" }], generating: false }, 3000);
  assert.equal(state.done, false);
  assert.equal(state.status, "placeholder");
});

test("web prompts are bounded with head and tail preserved", () => {
  const source = "A".repeat(10000) + "MIDDLE".repeat(2000) + "Z".repeat(10000);
  const compacted = compactWebPrompt(source, { limit: WEB_PROMPT_MAX_CHARS });
  assert.equal(compacted.truncated, true);
  assert.ok(compacted.text.length <= WEB_PROMPT_MAX_CHARS);
  assert.match(compacted.text, /^A+/);
  assert.match(compacted.text, /Z+$/);
});
