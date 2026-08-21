import test from "node:test";
import assert from "node:assert/strict";
import { createRelayEngine } from "../src/bridge/relay_engine.mjs";

test("relay engine supports manual link, one-shot, and bounded rounds", async () => {
  const manual = createRelayEngine({ config: { rounds: 0 } });
  assert.equal(manual.status().state, "ready");
  const oneShot = createRelayEngine({ config: { mode: "one_shot" }, verifyDestination: async () => undefined, sendMessage: async envelope => envelope.content });
  const sent = await oneShot.send({ content: "hello", provider: "chatgpt" });
  assert.equal(sent.sent, true);
  assert.equal(oneShot.status().state, "completed");

  let rounds = 0;
  const bounded = createRelayEngine({
    config: { rounds: 2, goal: "finish" },
    executeRound: async () => { rounds += 1; return { status: "continue" }; },
  });
  const result = await bounded.run();
  assert.equal(rounds, 2);
  assert.equal(result.status, "max_rounds");
  assert.equal(bounded.status().state, "paused");
});

test("relay engine accepts a goal after the post-connection user question", () => {
  const engine = createRelayEngine({ config: { mode: "continuous", goal_source: "plugin_question" } });
  assert.equal(engine.status().goal, "");
  engine.setGoal("finish the user's requested task");
  assert.equal(engine.status().goal, "finish the user's requested task");
});

test("relay engine pauses on destination mismatch and deduplicates inbound messages", async () => {
  const engine = createRelayEngine({
    config: { mode: "continuous", goal: "keep going" },
    verifyDestination: async () => { const error = new Error("conversation changed"); error.code = "DESTINATION_CONVERSATION_MISMATCH"; throw error; },
  });
  const blocked = await engine.send({ content: "do not send", provider: "chatgpt" });
  assert.equal(blocked.sent, false);
  assert.equal(engine.status().state, "paused");

  let calls = 0;
  const receive = createRelayEngine({
    config: { rounds: 0 },
    receiveMessage: async () => { calls += 1; return { content: "same reply" }; },
  });
  const first = await receive.receive({ provider: "chatgpt" });
  const second = await receive.receive({ provider: "chatgpt" });
  assert.equal(first.received, true);
  assert.equal(second.new_message, false);
  assert.equal(calls, 2);
});
