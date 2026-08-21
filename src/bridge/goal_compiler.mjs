// Codex App Server's native thread/goal/set endpoint accepts at most 4000 chars.
// Keep the bridge goal within that same bound so the persisted Bridge Goal and
// the native Codex Goal cannot diverge just because of transport limits.
const MAX_GOAL_LENGTH = 4000;
const TRUNCATION_SUFFIX = "...[truncated]";

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

export function compileUserGoal(answer) {
  const source = text(answer);
  if (!source) throw new Error("请先回答你希望完成什么目标");
  const goal = source.length <= MAX_GOAL_LENGTH
    ? source
    : `${source.slice(0, MAX_GOAL_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
  const title = goal.split(/\r?\n/)[0].replace(/^[#\-\s]+/, "").trim().slice(0, 120) || "当前 Codex 目标";
  return {
    goal,
    title,
    source: "codex_user_answer",
    compiled_at: new Date().toISOString(),
    success_criteria: ["完成用户描述的目标，并返回可验证的执行证据"],
  };
}

export const GOAL_COMPILER_MAX_LENGTH = MAX_GOAL_LENGTH;
