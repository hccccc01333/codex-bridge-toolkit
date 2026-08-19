import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRepeated,
  fingerprint,
  roundLimitReached,
} from "../src/orchestration/stop_policy.mjs";

test("T5 identical decisions or reports are detected as repeated", () => {
  const decision = { status: "continue", task: "same task", acceptance: [], reason: "same" };
  const decisionKey = fingerprint({
    status: decision.status,
    task: decision.task,
    acceptance: decision.acceptance,
    reason: decision.reason,
  });
  const reportKey = fingerprint({ report: "same report" });
  const result = detectRepeated({
    decision,
    decisionHistory: [decisionKey],
    reportFingerprint: reportKey,
    reportHistory: [reportKey, reportKey],
  });
  assert.equal(result.repeated, true);
  assert.equal(result.repeated_decision, true);
  assert.equal(result.repeated_report, true);
});

test("T6 max_rounds stops before starting another round", () => {
  assert.equal(roundLimitReached(2, 3), true);
  assert.equal(roundLimitReached(1, 3), false);
  assert.equal(roundLimitReached(49, 100), true);
});
