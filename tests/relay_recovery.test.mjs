import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLatestCodexPeerMessage,
  reconcileRelay,
  relayContentHash,
} from "../src/bridge/relay_recovery.mjs";

test("recovery selects the newer unacknowledged web peer as the next initiator", () => {
  const result = reconcileRelay({
    codex: { content: "Codex earlier task", displayed_at: "2026-08-30T01:00:00.000Z" },
    web: { content: "Web completed report", displayed_at: "2026-08-30T01:02:00.000Z" },
    handoffs: [],
  });
  assert.equal(result.status, "recovery_ready");
  assert.equal(result.interruption_side, "web_to_codex");
  assert.equal(result.next_initiator, "web");
  assert.equal(result.confidence, "high");
});

test("recovery does not guess when both unacknowledged peers have equal timestamps", () => {
  const result = reconcileRelay({
    codex: { content: "Codex task", displayed_at: "2026-08-30T01:00:00.000Z" },
    web: { content: "Web reply", displayed_at: "2026-08-30T01:00:00.000Z" },
    handoffs: [],
  });
  assert.equal(result.status, "paused");
  assert.equal(result.next_initiator, null);
});

test("recovery waits instead of resending an unresolved web delivery", () => {
  const result = reconcileRelay({
    web: { content: "previous reply", displayed_at: "2026-08-30T01:00:00.000Z" },
    codex: { content: "【网页端 → Codex 搬运】\nprevious reply", displayed_at: "2026-08-30T01:00:01.000Z" },
    handoffs: [{
      direction: "codex_to_web",
      state: "submitted",
      content_hash: relayContentHash("need a web reply"),
      updated_at: "2026-08-30T01:00:02.000Z",
    }, {
      direction: "web_to_codex",
      state: "delivered_to_codex",
      content_hash: relayContentHash("previous reply"),
      updated_at: "2026-08-30T01:00:01.000Z",
    }],
  });
  assert.equal(result.status, "waiting_for_web");
  assert.equal(result.next_initiator, "web");
});

test("Codex thread reader picks the latest assistant item and ignores relay envelopes", () => {
  const snapshot = extractLatestCodexPeerMessage({
    items: [
      { type: "agentMessage", id: "old", createdAt: "2026-08-30T01:00:00.000Z", content: [{ text: "old answer" }] },
      { type: "agentMessage", id: "relay", createdAt: "2026-08-30T01:02:00.000Z", content: [{ text: "【网页端 → Codex 搬运】\nprevious peer output" }] },
      { type: "agentMessage", id: "latest", createdAt: "2026-08-30T01:01:00.000Z", content: [{ text: "latest Codex answer" }] },
    ],
  }, "2026-08-30T01:03:00.000Z");
  assert.equal(snapshot.source_message_id, "latest");
  assert.equal(snapshot.displayed_at, "2026-08-30T01:01:00.000Z");
  assert.equal(snapshot.content_hash, relayContentHash("latest Codex answer"));
});
