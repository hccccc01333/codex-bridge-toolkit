const DEFAULT_STABLE_POLLS = 5;
const DEFAULT_MIN_STABLE_MS = 1800;
const PLACEHOLDER_RE = /^(正在思考|思考中|生成中|generating|thinking|loading)\.{0,3}$/i;

function text(value) {
  return String(value ?? "").trim();
}

function normalizeMessages(snapshot = {}) {
  const source = Array.isArray(snapshot.assistant_messages) && snapshot.assistant_messages.length
    ? snapshot.assistant_messages
    : (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((value, index) => ({
      id: `assistant-${index}`,
      text: value,
    }));
  return source
    .map((message, index) => ({
      id: text(message?.id) || `assistant-${index}`,
      text: text(message?.text ?? message),
    }))
    .filter(message => message.text);
}

export function createReplyTracker(before = {}, {
  stablePollsRequired = DEFAULT_STABLE_POLLS,
  minStableMs = DEFAULT_MIN_STABLE_MS,
  now = Date.now(),
} = {}) {
  const messages = normalizeMessages(before);
  return {
    baselineIds: new Set(messages.map(message => message.id)),
    baselineTexts: new Map(messages.map(message => [message.id, message.text])),
    baselineLastId: messages.at(-1)?.id || "",
    baselineLastText: messages.at(-1)?.text || "",
    submittedAt: now,
    stablePollsRequired: Math.max(2, Number(stablePollsRequired) || DEFAULT_STABLE_POLLS),
    minStableMs: Math.max(0, minStableMs === undefined ? DEFAULT_MIN_STABLE_MS : Number(minStableMs) || 0),
    candidate: null,
    candidateText: "",
    stablePolls: 0,
  };
}

export function observeReply(tracker, snapshot = {}, now = Date.now()) {
  const messages = normalizeMessages(snapshot);
  const candidates = messages.filter(message => {
    if (!tracker.baselineIds.has(message.id)) return true;
    return message.id === tracker.baselineLastId && message.text !== tracker.baselineLastText;
  });
  const candidate = candidates.at(-1) || null;
  if (!candidate) {
    return { done: false, status: "waiting_for_new_message", generating: Boolean(snapshot.generating), messages };
  }

  if (tracker.candidate === candidate.id && tracker.candidateText === candidate.text) {
    tracker.stablePolls += 1;
  } else {
    tracker.candidate = candidate.id;
    tracker.candidateText = candidate.text;
    tracker.stablePolls = 1;
  }

  const placeholder = PLACEHOLDER_RE.test(candidate.text);
  const stableLongEnough = now - tracker.submittedAt >= tracker.minStableMs;
  const done = !snapshot.generating
    && !placeholder
    && stableLongEnough
    && tracker.stablePolls >= tracker.stablePollsRequired;
  return {
    done,
    status: done ? "completed" : placeholder ? "placeholder" : "stabilizing",
    generating: Boolean(snapshot.generating),
    candidate,
    stablePolls: tracker.stablePolls,
    messages,
  };
}

export function compactWebPrompt(value, { limit = 12000 } = {}) {
  const source = String(value ?? "");
  const max = Math.max(1000, Number(limit) || 12000);
  if (source.length <= max) return { text: source, truncated: false, originalLength: source.length, limit: max };
  const head = Math.max(1, Math.floor(max * 0.6));
  const tail = Math.max(1, max - head - 80);
  return {
    text: `${source.slice(0, head)}\n\n[Bridge payload clipped: ${source.length - head - tail} characters omitted]\n\n${source.slice(-tail)}`,
    truncated: true,
    originalLength: source.length,
    limit: max,
  };
}

export const WEB_PROMPT_MAX_CHARS = 12000;
export const WEB_REPLY_STABLE_POLLS = DEFAULT_STABLE_POLLS;
export const WEB_REPLY_MIN_STABLE_MS = DEFAULT_MIN_STABLE_MS;
