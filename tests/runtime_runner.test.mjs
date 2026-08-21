import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeRunner } from "../src/runtime/runner.mjs";

function mcp(structuredContent, text = "ok") {
  return { content: [{ type: "text", text }], structuredContent };
}

function createHarness({ reviews = [{ status: "completed", evidence: ["verified"] }], proof = ["unit test passed"] } = {}) {
  const state = {
    goal: "ship the feature",
    maxRounds: 3,
    round: 0,
    latestPlan: null,
    latestReport: null,
    latestReview: null,
  };
  const calls = [];
  const events = [];
  let reviewIndex = 0;
  const runner = createRuntimeRunner({
    getState: () => state,
    planner: async () => {
      calls.push("plan");
      return mcp({ status: "continue", task: "task-1", acceptance: ["check it"] });
    },
    executor: async ({ task }) => {
      calls.push(`execute:${task}`);
      return mcp({ completed: true, text: `result-${task}`, tests: proof });
    },
    reporter: async ({ report }) => {
      calls.push(`report:${report.report}`);
      state.latestReport = report;
      return mcp({ reported: true });
    },
    reviewer: async () => {
      const review = reviews[Math.min(reviewIndex++, reviews.length - 1)];
      calls.push(`review:${review.status}`);
      return mcp({ ...review, next_task: review.next_task || "task-2" });
    },
    emit: async event => events.push(event),
    persist: async () => calls.push("persist"),
  });
  return { runner, state, calls, events };
}

test("runtime runner closes one plan-execute-report-review round", async () => {
  const harness = createHarness();
  const result = await harness.runner.runRound({ max_rounds: 3 });

  assert.equal(result.stopped, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(harness.calls.slice(0, 4), [
    "plan",
    "execute:task-1",
    "report:result-task-1",
    "review:completed",
  ]);
  assert.deepEqual(harness.events.map(event => event.type), ["TASK", "RESULT", "EVIDENCE", "REVIEW"]);
  assert.equal(result.report.tests[0], "unit test passed");
  assert.equal(result.review.completion_proof.proven, true);
});

test("run_until_stop reuses the next plan and stops on a later completed review", async () => {
  const harness = createHarness({ reviews: [
    { status: "continue", next_task: "task-2" },
    { status: "completed", next_task: "" },
  ] });
  const result = await harness.runner.runUntilStop({ max_rounds: 3 });

  assert.equal(result.status, "completed");
  assert.equal(result.rounds_run, 2);
  assert.deepEqual(harness.calls.filter(call => call === "plan"), ["plan"]);
  assert.deepEqual(harness.calls.filter(call => call.startsWith("execute:")), ["execute:task-1", "execute:task-2"]);
  assert.equal(harness.state.round, 1);
});

test("continuous mode has no user round ceiling and stops on the web review", async () => {
  const harness = createHarness({ reviews: [
    { status: "continue", next_task: "task-2" },
    { status: "continue", next_task: "task-3" },
    { status: "completed", next_task: "" },
  ] });
  const result = await harness.runner.runUntilStop({ continuous: true, safety_limit: 5 });

  assert.equal(result.status, "completed");
  assert.equal(result.max_rounds, null);
  assert.equal(result.rounds_run, 3);
  assert.equal(harness.state.continuous, true);
});

test("continuous mode stops at its internal safety limit when no terminal review arrives", async () => {
  const harness = createHarness({ reviews: [{ status: "continue", next_task: "again" }] });
  const result = await harness.runner.runUntilStop({ continuous: true, safety_limit: 2 });

  assert.equal(result.status, "continuous_safety_limit");
  assert.equal(result.safety_limit, 2);
  assert.equal(result.rounds_run, 2);
});

test("runtime runner refreshes state after a planner resets the brain state", async () => {
  let state = { goal: "", maxRounds: 2, round: 0, latestPlan: null, latestReview: null };
  const executed = [];
  let reviews = 0;
  const runner = createRuntimeRunner({
    getState: () => state,
    planner: async () => {
      state = { goal: "fresh goal", maxRounds: 2, round: 0, latestPlan: null, latestReview: null };
      return mcp({ status: "continue", task: "first task" });
    },
    executor: async ({ task }) => {
      executed.push(task);
      return mcp({ completed: true, text: task, tests: ["passed"] });
    },
    reporter: async () => mcp({ reported: true }),
    reviewer: async () => mcp(reviews++ === 0
      ? { status: "continue", next_task: "second task" }
      : { status: "completed" }),
  });

  const result = await runner.runUntilStop({ max_rounds: 2 });
  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["first task", "second task"]);
  assert.equal(state.round, 1);
});

test("runtime runner applies the evidence gate and max-round stop policy", async () => {
  const noEvidence = createHarness({ reviews: [{ status: "completed", evidence: [] }], proof: [] });
  const blocked = await noEvidence.runner.runRound({ max_rounds: 3 });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.review.completion_proof.proven, false);

  const maxed = createHarness({ reviews: [{ status: "continue", next_task: "task-2" }] });
  const stopped = await maxed.runner.runRound({ max_rounds: 1 });
  assert.equal(stopped.status, "max_rounds");
  assert.equal(maxed.state.latestReview.status, "max_rounds");
});

test("executor failures become explicit blocked runtime stops", async () => {
  const events = [];
  const state = { goal: "approval boundary", maxRounds: 2, round: 0, latestPlan: null, latestReview: null };
  const runner = createRuntimeRunner({
    getState: () => state,
    planner: async () => mcp({ status: "continue", task: "needs approval" }),
    executor: async () => ({ isError: true, content: [{ type: "text", text: "approval required" }], structuredContent: { code: "APPROVAL_REQUIRED" } }),
    reporter: async () => mcp({ reported: true }),
    reviewer: async () => mcp({ status: "completed" }),
    emit: async event => events.push(event),
  });

  const result = await runner.runRound();
  assert.equal(result.status, "blocked");
  assert.equal(result.stage, "execute");
  assert.equal(result.code, "APPROVAL_REQUIRED");
  assert.equal(events.at(-1).type, "BLOCKED");
});
