import test from "node:test";
import assert from "node:assert/strict";
import {
  compactExecutorReport,
  completionProof,
  enforceEvidenceFirst,
  taskIRFromArgs,
} from "../scripts/protocol.mjs";

test("T1 taskIR clips and bounds planning inputs", () => {
  const ir = taskIRFromArgs({
    goal: "g".repeat(7000),
    constraints: Array.from({ length: 60 }, (_, index) => `c-${index}`),
    risk: "high",
  });
  assert.equal(ir.goal.length, 6014);
  assert.equal(ir.constraints.length, 40);
  assert.equal(ir.risk, "high");
});

test("T2 executor reports are compact and bounded", () => {
  const report = compactExecutorReport({
    changes: Array.from({ length: 60 }, (_, index) => `change-${index}`),
    report: "r".repeat(7000),
  });
  assert.equal(report.changes.length, 40);
  assert.equal(report.report.length, 6014);
});

test("T3 completed without proof is downgraded to blocked", () => {
  const result = enforceEvidenceFirst({ status: "completed" }, {});
  assert.equal(result.decision.status, "blocked");
  assert.deepEqual(result.proof.missing, ["tests", "evidence"]);
});

test("T4 completed with evidence remains completed", () => {
  const result = enforceEvidenceFirst(
    { status: "completed" },
    { tests: ["node --check scripts/mcp_server.mjs"] },
  );
  assert.equal(result.decision.status, "completed");
  assert.equal(result.proof.proven, true);
});
