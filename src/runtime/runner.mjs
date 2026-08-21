import { compactExecutorReport, enforceEvidenceFirst } from "../../scripts/protocol.mjs";
import {
  DEFAULT_MAX_ROUNDS,
  maxRoundsOf as defaultMaxRoundsOf,
  roundLimitReached as defaultRoundLimitReached,
} from "../orchestration/stop_policy.mjs";

export const TERMINAL_STATUSES = new Set(["completed", "blocked", "repeated", "max_rounds", "continuous_safety_limit"]);
export const DEFAULT_CONTINUOUS_SAFETY_LIMIT = 1000;

function list(value) {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item).slice(0, 1000).trim()).filter(Boolean).slice(0, 40);
}

function clip(value, limit = 6000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function structured(result) {
  if (!result || typeof result !== "object") return {};
  return result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : result;
}

function resultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const contentText = result.content?.find(item => item?.type === "text")?.text;
  return String(result.text ?? result.reply ?? result.output ?? contentText ?? "");
}

function resultError(result) {
  if (result?.isError) {
    const data = structured(result);
    return {
      message: resultText(result) || data.reason || "runtime stage failed",
      code: data.code || "RUNTIME_STAGE_FAILED",
    };
  }
  return null;
}

function statusOf(data, fallback = "continue") {
  const value = String(data?.status || data?.decision || fallback).toLowerCase();
  if (["completed", "complete", "done", "finished", "success"].includes(value)) return "completed";
  if (["blocked", "blocker"].includes(value)) return "blocked";
  if (["repeated", "repeat", "loop"].includes(value)) return "repeated";
  if (["max_rounds", "max-rounds"].includes(value)) return "max_rounds";
  if (["continuous_safety_limit", "continuous-safety-limit"].includes(value)) return "continuous_safety_limit";
  return "continue";
}

function continuousOf(args = {}, state = {}) {
  return args.continuous === true || args.mode === "continuous" || state.continuous === true;
}

export function normalizeRuntimePlan(result, fallback = {}) {
  const data = structured(result);
  return {
    round: Number.isInteger(Number(data.round)) ? Number(data.round) : Number(fallback.round || 0),
    status: statusOf(data, fallback.status || "continue"),
    task: String(data.task || data.next_task || data.nextTask || fallback.task || "").trim(),
    constraints: list(data.constraints ?? fallback.constraints),
    acceptance: list(data.acceptance ?? fallback.acceptance),
    evidence: list(data.evidence ?? fallback.evidence),
    reason: String(data.reason || fallback.reason || "").trim(),
  };
}

export function normalizeRuntimeReview(result, fallback = {}) {
  const data = structured(result);
  return {
    round: Number.isInteger(Number(data.round)) ? Number(data.round) : Number(fallback.round || 0),
    status: statusOf(data, fallback.status || "continue"),
    task: String(data.task || data.next_task || data.nextTask || fallback.task || "").trim(),
    constraints: list(data.constraints ?? fallback.constraints),
    acceptance: list(data.acceptance ?? fallback.acceptance),
    evidence: list(data.evidence ?? fallback.evidence),
    reason: String(data.reason || fallback.reason || "").trim(),
    repeated_detected: Boolean(data.repeated_detected),
    completion_proof: data.completion_proof || null,
  };
}

export function compileExecutorReport(execution, { round = 0 } = {}) {
  const data = structured(execution);
  const nested = data.report && typeof data.report === "object" ? data.report : {};
  const text = clip(
    data.text
      || data.reply
      || data.output
      || (typeof data.report === "string" ? data.report : "")
      || resultText(execution),
  );
  return compactExecutorReport({
    round,
    status: data.status || (data.completed === false ? "incomplete" : "reported"),
    report: text || JSON.stringify({
      changes: list(data.changes ?? nested.changes),
      tests: list(data.tests ?? nested.tests),
      blockers: list(data.blockers ?? nested.blockers),
      evidence: list(data.evidence ?? nested.evidence),
    }),
    changes: list(data.changes ?? nested.changes),
    tests: list(data.tests ?? nested.tests),
    blockers: list(data.blockers ?? nested.blockers),
    evidence: list(data.evidence ?? nested.evidence),
  });
}

export function defaultAdvanceState(state, review, nextRound) {
  const nextPlan = {
    round: nextRound,
    status: "continue",
    task: review.task,
    acceptance: review.acceptance,
    constraints: review.constraints,
    evidence: review.evidence,
    reason: review.reason,
  };
  state.round = nextRound;
  state.latestPlan = nextPlan;
  return nextPlan;
}

function roundSummary(result) {
  return {
    continued: Boolean(result.continued),
    stopped: Boolean(result.stopped),
    status: result.status || null,
    stage: result.stage || null,
    round: result.round ?? null,
    max_rounds: result.max_rounds ?? null,
    task: result.task || result.plan?.task || result.review?.task || null,
    reason: result.reason || result.review?.reason || null,
    report: result.report ? {
      round: result.report.round,
      status: result.report.status,
      changes: result.report.changes,
      tests: result.report.tests,
      blockers: result.report.blockers,
      evidence: result.report.evidence,
    } : null,
    review: result.review ? {
      status: result.review.status,
      task: result.review.task,
      reason: result.review.reason,
    } : null,
  };
}

export function createRuntimeRunner({
  getState,
  planner,
  executor,
  reporter,
  reviewer,
  persist = async () => undefined,
  emit = async () => undefined,
  onStop = () => undefined,
  advance = defaultAdvanceState,
  maxRoundsOf = defaultMaxRoundsOf,
  roundLimitReached = defaultRoundLimitReached,
} = {}) {
  if (typeof getState !== "function") throw new TypeError("runtime runner requires getState");
  for (const [name, callback] of Object.entries({ planner, executor, reporter, reviewer })) {
    if (typeof callback !== "function") throw new TypeError(`runtime runner requires ${name}`);
  }

  async function trace(type, summary, data = undefined) {
    await emit({ type, summary, data });
  }

  async function stop(state, decision) {
    const result = { continued: false, stopped: true, ...decision };
    await onStop({ state, decision: result });
    await persist({ state, decision: result });
    await trace(result.status === "blocked" ? "BLOCKED" : "REVIEW", `runtime stopped: ${result.status}`, result);
    return result;
  }

  async function runRound(args = {}) {
    let state = getState();
    const continuous = continuousOf(args, state);
    let maxRounds = continuous ? null : maxRoundsOf(args.max_rounds ?? state.maxRounds ?? DEFAULT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    state.continuous = continuous;
    state.maxRounds = maxRounds;
    const round = Number.isInteger(Number(state.round)) ? Number(state.round) : 0;
    const existingTerminal = state.latestReview?.status || state.latestPlan?.status;
    if (TERMINAL_STATUSES.has(existingTerminal)) {
      return stop(state, {
        status: existingTerminal,
        round,
        max_rounds: maxRounds,
        reason: state.latestReview?.reason || `runtime is already stopped: ${existingTerminal}`,
        stage: "preflight",
      });
    }

    let plan = state.latestPlan?.task && state.latestPlan.status === "continue"
      ? normalizeRuntimePlan(state.latestPlan, { round })
      : null;
    if (!plan) {
      const planResult = await planner({ ...args, round });
      const planError = resultError(planResult);
      if (planError) {
        return stop(state, { status: "blocked", round, max_rounds: maxRounds, stage: "plan", reason: planError.message, code: planError.code });
      }
      state = getState();
      maxRounds = continuous ? null : maxRoundsOf(args.max_rounds ?? state.maxRounds ?? DEFAULT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
      plan = normalizeRuntimePlan(planResult, { round });
      state.latestPlan = plan;
    }
    if (TERMINAL_STATUSES.has(plan.status)) {
      return stop(state, { status: plan.status, round, max_rounds: maxRounds, stage: "plan", reason: plan.reason || "planner returned a terminal decision" });
    }
    if (!plan.task) {
      return stop(state, { status: "blocked", round, max_rounds: maxRounds, stage: "plan", reason: "planner returned no executable task" });
    }

    await trace("TASK", `runtime round ${round}: ${plan.task}`, { round, task: plan.task, acceptance: plan.acceptance, constraints: plan.constraints });
    const executionResult = await executor({ ...args, round, task: plan.task, text: plan.task, plan });
    const executionError = resultError(executionResult);
    if (executionError) {
      return stop(state, { status: "blocked", round, max_rounds: maxRounds, stage: "execute", reason: executionError.message, code: executionError.code });
    }

    const report = compileExecutorReport(executionResult, { round });
    await trace("RESULT", `runtime executor result for round ${round}`, report);
    const reportResult = await reporter({ ...args, round, plan, report, report_text: report.report });
    const reportError = resultError(reportResult);
    if (reportError) {
      return stop(state, { status: "blocked", round, max_rounds: maxRounds, stage: "report", reason: reportError.message, code: reportError.code });
    }
    await trace("EVIDENCE", `runtime evidence recorded for round ${round}`, report);

    const reviewResult = await reviewer({ ...args, round, plan, report, execution: executionResult });
    const reviewError = resultError(reviewResult);
    if (reviewError) {
      return stop(state, { status: "blocked", round, max_rounds: maxRounds, stage: "review", reason: reviewError.message, code: reviewError.code });
    }
    let review = normalizeRuntimeReview(reviewResult, { round });
    const evidenceGate = enforceEvidenceFirst(review, report);
    review = { ...review, ...evidenceGate.decision, completion_proof: evidenceGate.proof };
    state.latestReview = review;
    await trace("REVIEW", `runtime review for round ${round}: ${review.status}`, review);

    if (TERMINAL_STATUSES.has(review.status)) {
      await persist({ state, decision: review });
      return { continued: false, stopped: true, status: review.status, round, max_rounds: maxRounds, review, report };
    }
    if (!continuous && roundLimitReached(round, maxRounds)) {
      state.latestReview = { ...review, status: "max_rounds", reason: `maximum rounds reached: ${maxRounds}` };
      return stop(state, { status: "max_rounds", round, max_rounds: maxRounds, stage: "stop_policy", reason: state.latestReview.reason, review, report });
    }

    const nextRound = round + 1;
    const nextPlan = await advance(state, review, nextRound);
    await persist({ state, decision: review, nextPlan });
    return {
      continued: true,
      stopped: false,
      status: "continue",
      round: nextRound,
      max_rounds: maxRounds,
      task: nextPlan?.task || review.task,
      plan: nextPlan,
      review,
      report,
    };
  }

  async function runUntilStop(args = {}) {
    const state = getState();
    const continuous = continuousOf(args, state);
    const maxRounds = continuous ? null : maxRoundsOf(args.max_rounds ?? state.maxRounds ?? DEFAULT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    const rounds = [];
    const safetyLimit = Math.max(1, Number(args.safety_limit ?? DEFAULT_CONTINUOUS_SAFETY_LIMIT));
    const hardLimit = continuous ? safetyLimit : maxRounds + 1;
    for (let index = 0; index < hardLimit; index += 1) {
      const result = await runRound({ ...args, continuous, max_rounds: continuous ? undefined : maxRounds });
      rounds.push(result);
      if (result.stopped || !result.continued) {
        return { ...result, rounds: rounds.map(roundSummary), rounds_run: rounds.length };
      }
    }
    return stop(getState(), {
      status: continuous ? "continuous_safety_limit" : "max_rounds",
      round: Number(state.round || 0),
      max_rounds: maxRounds,
      safety_limit: continuous ? safetyLimit : undefined,
      stage: "stop_policy",
      reason: continuous
        ? `continuous safety limit reached: ${safetyLimit}`
        : `runtime safety limit reached: ${maxRounds}`,
      rounds: rounds.map(roundSummary),
      rounds_run: rounds.length,
    });
  }

  return { runRound, runUntilStop };
}
