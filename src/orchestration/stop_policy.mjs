import { createHash } from "node:crypto";

export const DEFAULT_MAX_ROUNDS = 20;
export const HARD_MAX_ROUNDS = 50;

export function fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function maxRoundsOf(value, fallback = DEFAULT_MAX_ROUNDS) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, HARD_MAX_ROUNDS);
}

export function detectRepeated({ decision, decisionHistory = [], reportFingerprint = "", reportHistory = [] } = {}) {
  const decisionKey = fingerprint({
    status: decision?.status,
    task: decision?.task,
    acceptance: decision?.acceptance,
    reason: decision?.reason,
  });
  const repeatedDecision = decisionHistory.includes(decisionKey);
  const repeatedReport = Boolean(reportFingerprint)
    && reportHistory.filter(key => key === reportFingerprint).length > 1;
  return {
    repeated: repeatedDecision || repeatedReport,
    decision_key: decisionKey,
    repeated_decision: repeatedDecision,
    repeated_report: repeatedReport,
  };
}

export function roundLimitReached(round, maxRounds) {
  const limit = maxRoundsOf(maxRounds);
  return Number(round) >= limit - 1;
}
