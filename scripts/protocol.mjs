export const PROTOCOL_TYPES = [
  "TASK",
  "RESULT",
  "EVIDENCE",
  "QUESTION",
  "REVIEW",
  "BLOCKED",
  "COMPLETED",
];

const MAX_FIELD_CHARS = 6000;
const MAX_LIST_ITEMS = 40;

function clip(value, limit = MAX_FIELD_CHARS) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function stringList(value) {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => clip(item, 1000).trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS);
}

function boundedInteger(value, fallback = 6000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100) return fallback;
  return Math.min(parsed, 24000);
}

export function taskIRFromArgs(args = {}) {
  return {
    phase: "plan",
    goal: clip(args.goal),
    constraints: stringList(args.constraints),
    context: clip(args.context),
    workspace_state: clip(args.workspace_state ?? args.workspace),
    previous_result: clip(args.previous_result ?? args.result),
    evidence: stringList(args.evidence),
    risk: ["low", "medium", "high"].includes(String(args.risk || "").toLowerCase())
      ? String(args.risk).toLowerCase()
      : "medium",
    token_budget: boundedInteger(args.token_budget),
  };
}

export function compactExecutorReport(report = {}) {
  return {
    round: Number.isInteger(Number(report.round)) ? Number(report.round) : 0,
    status: clip(report.status, 200) || "reported",
    changes: stringList(report.changes),
    tests: stringList(report.tests),
    blockers: stringList(report.blockers),
    evidence: stringList(report.evidence),
    report: clip(report.report),
  };
}

export function completionProof(report = {}) {
  const compact = compactExecutorReport(report);
  const tests = compact.tests.length;
  const evidence = compact.evidence.length;
  const changes = compact.changes.length;
  return {
    proven: tests > 0 || evidence > 0,
    tests,
    evidence,
    changes,
    missing: tests > 0 || evidence > 0 ? [] : ["tests", "evidence"],
    rule: "completed requires at least one structured test or evidence item",
  };
}

export function enforceEvidenceFirst(decision = {}, report = {}) {
  const proof = completionProof(report);
  const adjusted = { ...decision };
  if (adjusted.status === "completed" && !proof.proven) {
    adjusted.status = "blocked";
    adjusted.reason = "completion was claimed without structured test or evidence proof";
    adjusted.evidence = [...(adjusted.evidence || []), ...proof.missing.map(item => `missing proof: ${item}`)];
  }
  return { decision: adjusted, proof };
}

export function compileProtocolMessage(type, payload = {}) {
  const normalizedType = String(type || "EVENT").toUpperCase();
  return {
    type: PROTOCOL_TYPES.includes(normalizedType) ? normalizedType : "EVENT",
    summary: clip(payload.summary || payload.message, 1200),
    data: payload.data === undefined ? undefined : compactExecutorReport(payload.data),
  };
}
