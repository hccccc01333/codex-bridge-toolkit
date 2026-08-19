import { compactExecutorReport } from "../../scripts/protocol.mjs";
import { fingerprint } from "./stop_policy.mjs";

const MAX_CONTEXT_CHARS = 24000;

export function newBrainState(defaultMaxRounds = 20) {
  return {
    mode: "brain-hand",
    goal: "",
    taskIR: null,
    constraints: [],
    maxRounds: defaultMaxRounds,
    round: 0,
    latestPlan: null,
    latestReport: null,
    latestReview: null,
    seenTaskFingerprints: [],
    seenReportFingerprints: [],
    seenDecisionFingerprints: [],
    lastWebReply: "",
    startedAt: null,
  };
}

export function clip(value, limit = MAX_CONTEXT_CHARS) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

export function stringList(value) {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item).trim()).filter(Boolean).slice(0, 50);
}

export function firstNonEmpty(...values) {
  return values.find(value => typeof value === "string" && value.trim())?.trim() || "";
}

export function findJsonObject(text) {
  const source = String(text || "");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], source].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        if (start < 0) start = index;
        depth += 1;
      } else if (char === "}" && start >= 0) {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, index + 1));
            if (parsed && typeof parsed === "object") return parsed;
          } catch {}
          start = -1;
        }
      }
    }
  }
  return null;
}

export function normalizeStatus(value, text = "") {
  const source = String(value || text || "").toLowerCase();
  if (/completed|complete|done|finished|success|已完成|完成/.test(source)) return "completed";
  if (/blocked|blocker|阻塞|无法继续|被阻塞/.test(source)) return "blocked";
  if (/repeated|repeat|loop|duplicate|重复|循环/.test(source)) return "repeated";
  if (/max[_ -]?round|轮数上限/.test(source)) return "max_rounds";
  return "continue";
}

export function taskFromReply(parsed, rawReply) {
  const plan = parsed?.plan && typeof parsed.plan === "object" ? parsed.plan : {};
  const task = firstNonEmpty(
    parsed?.next_task,
    parsed?.nextTask,
    parsed?.task,
    parsed?.next_action,
    parsed?.nextAction,
    parsed?.action,
    plan.next_task,
    plan.task,
  );
  const acceptance = stringList(parsed?.acceptance ?? parsed?.acceptance_criteria ?? parsed?.acceptanceCriteria ?? plan.acceptance);
  const constraints = stringList(parsed?.constraints ?? plan.constraints);
  const evidence = stringList(parsed?.evidence ?? parsed?.required_evidence ?? parsed?.requiredEvidence ?? plan.evidence);
  const reason = firstNonEmpty(parsed?.reason, parsed?.rationale, parsed?.summary, plan.reason);
  return {
    task: task || clip(rawReply, 6000),
    acceptance,
    constraints,
    evidence,
    reason,
  };
}

export function decisionFromReply(rawReply) {
  const parsed = findJsonObject(rawReply) || {};
  const task = taskFromReply(parsed, rawReply);
  const status = normalizeStatus(parsed.status ?? parsed.decision ?? parsed.result, rawReply);
  return {
    status,
    ...task,
    raw_reply: clip(rawReply),
    parsed,
  };
}

export function recordTask(brainState, task) {
  const key = fingerprint({ task: task.task, acceptance: task.acceptance, constraints: task.constraints });
  if (key && !brainState.seenTaskFingerprints.includes(key)) brainState.seenTaskFingerprints.push(key);
  return key;
}

export function recordReport(brainState, report) {
  const key = fingerprint(report);
  if (key) {
    brainState.seenReportFingerprints.push(key);
    if (brainState.seenReportFingerprints.length > 100) brainState.seenReportFingerprints.shift();
  }
  return key;
}

export function planPrompt(goal, constraints, context) {
  return `You are the planning brain supervising the configured executor.
Create the next concrete, verifiable task for the executor. Do not claim that you edited files or ran commands.
Use only the supplied context. Return JSON only, with this shape:
{"status":"continue","task":"one concrete next task","constraints":["..."],"acceptance":["..."],"evidence":["..."],"reason":"brief explanation"}
Allowed status values: continue, completed, blocked.

GOAL:
${clip(goal)}

CONSTRAINTS:
${JSON.stringify(constraints)}

CURRENT CONTEXT:
${clip(context || "No execution has started.")}`;
}

export function reportPrompt(goal, round, report) {
  return `The executor has submitted the following execution report.
Record it as external evidence. Do not invent changes, and do not provide a long analysis yet.
Reply with a concise acknowledgement and one important question only if required.

GOAL:
${clip(goal)}

ROUND: ${round}

EXECUTOR REPORT:
${clip(report)}`;
}

export function reviewPrompt({ goal, latestPlan, taskIR, latestReport, latestReview } = {}) {
  const report = latestReport || {};
  return `You are the planning brain reviewing the executor's latest work.
Decide whether the task is completed, blocked, repeated, or should continue.
Return JSON only, with this shape:
{"status":"continue|completed|blocked|repeated","next_task":"one concrete next task or empty","constraints":["..."],"acceptance":["..."],"evidence":["..."],"reason":"brief decision reason"}
Use completed only when the acceptance criteria are actually met. Use blocked when the executor cannot proceed without missing information or approval. Use repeated when the same action/result is looping without new evidence.
Completion must be evidence-first: a completed decision requires at least one structured test or evidence item in the executor report. If proof is missing, return blocked and explain what evidence is required.

GOAL:
${clip(goal)}

CURRENT PLAN:
${clip(JSON.stringify(latestPlan || {}, null, 2))}

TASK IR:
${clip(JSON.stringify(taskIR || {}, null, 2))}

LATEST EXECUTOR REPORT:
${clip(JSON.stringify(report, null, 2))}

PREVIOUS REVIEW:
${clip(JSON.stringify(latestReview || {}, null, 2))}`;
}

export function normalizeReport(args = {}, currentRound = 0) {
  const raw = firstNonEmpty(args.report, args.executor_report, args.result, args.summary);
  const reportObject = raw ? findJsonObject(raw) : null;
  return compactExecutorReport({
    round: Number.isInteger(Number(args.round)) ? Number(args.round) : currentRound,
    status: firstNonEmpty(args.status, reportObject?.status) || "reported",
    report: clip(raw || JSON.stringify({
      changes: stringList(args.changes),
      tests: stringList(args.tests),
      blockers: stringList(args.blockers),
      evidence: stringList(args.evidence),
    }, null, 2)),
    changes: stringList(args.changes ?? reportObject?.changes),
    tests: stringList(args.tests ?? reportObject?.tests),
    blockers: stringList(args.blockers ?? reportObject?.blockers),
    evidence: stringList(args.evidence ?? reportObject?.evidence),
  });
}
