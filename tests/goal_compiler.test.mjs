import test from "node:test";
import assert from "node:assert/strict";
import { compileUserGoal, GOAL_COMPILER_MAX_LENGTH } from "../src/bridge/goal_compiler.mjs";

test("goal compiler turns the user's answer into a bounded bridge goal", () => {
  const compiled = compileUserGoal("修复当前项目的测试，并保留验证证据");
  assert.equal(compiled.goal, "修复当前项目的测试，并保留验证证据");
  assert.equal(compiled.source, "codex_user_answer");
  assert.equal(compiled.success_criteria.length, 1);
  assert.throws(() => compileUserGoal("   "), /回答/);
  assert.ok(compileUserGoal("x".repeat(GOAL_COMPILER_MAX_LENGTH + 20)).goal.length <= GOAL_COMPILER_MAX_LENGTH);
});
