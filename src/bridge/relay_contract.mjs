import crypto from "node:crypto";

export const RELAY_MODES = Object.freeze(["one_shot", "bounded", "continuous"]);
export const RELAY_DIRECTIONS = Object.freeze(["codex_to_web", "web_to_codex"]);
export const CONNECTION_STATES = Object.freeze([
  "idle",
  "discovering",
  "browser_selected",
  "waiting_for_login",
  "awaiting_goal",
  "ready",
  "connected",
  "running",
  "paused",
  "completed",
  "blocked",
  "disconnected",
]);
export const MAX_RELAY_ROUNDS = 50;
export const STOP_TRIGGERS = Object.freeze([
  "conversation_mismatch",
  "provider_mismatch",
  "browser_disconnected",
  "tab_closed",
  "login_lost",
  "composer_not_found",
  "reply_parse_failed",
  "duplicate_loop",
  "repetition_detected",
  "round_limit",
  "user_stop",
  "generation_timeout",
]);

function text(value) {
  return String(value ?? "").trim();
}

function nonEmpty(value, fallback = "") {
  const result = text(value);
  return result || fallback;
}

function integer(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error("rounds must be an integer between 0 and 50");
  return result;
}

export function normalizeRelayMode(args = {}) {
  const requestedMode = text(args.mode ?? args.relay_mode ?? "").toLowerCase();
  const requestedRounds = integer(args.rounds ?? args.max_rounds, undefined);
  if (requestedRounds !== undefined && (requestedRounds < 0 || requestedRounds > MAX_RELAY_ROUNDS)) {
    throw new Error(`rounds must be between 0 and ${MAX_RELAY_ROUNDS}`);
  }

  if (requestedMode === "continuous" || requestedMode === "ongoing") {
    return { mode: "continuous", rounds: null, manual: false };
  }
  if (requestedMode === "one_shot" || requestedMode === "one-shot" || requestedMode === "single") {
    return { mode: "one_shot", rounds: 1, manual: false };
  }
  if (requestedMode && !["bounded", "rounds", "linked"].includes(requestedMode)) {
    throw new Error("mode must be one_shot, bounded, or continuous");
  }
  if (requestedRounds === 0) return { mode: "bounded", rounds: 0, manual: true };
  return { mode: "bounded", rounds: requestedRounds ?? 1, manual: false };
}

export function normalizeRelayDirection(value = "codex_to_web") {
  const direction = text(value).toLowerCase().replace(/[-\s]/g, "_");
  if (direction === "codex_to_web" || direction === "web_to_codex") return direction;
  throw new Error("direction must be codex_to_web or web_to_codex");
}

export function normalizeConnectionState(value = "idle") {
  const state = text(value).toLowerCase();
  if (CONNECTION_STATES.includes(state)) return state;
  throw new Error(`unknown connection state: ${value}`);
}

export function normalizeRelayConfig(args = {}) {
  const relay = normalizeRelayMode(args);
  const direction = normalizeRelayDirection(args.direction ?? args.start_direction);
  const goal = nonEmpty(args.goal);
  const goalSource = nonEmpty(args.goal_source, goal ? "explicit" : "none");
  if ((relay.mode === "continuous" || (relay.mode === "bounded" && relay.rounds > 0)) && !goal && !["codex_conversation", "plugin_question"].includes(goalSource)) {
    throw new Error("Brain-Hand mode requires a goal; the bridge will ask the user for one after connection");
  }
  return {
    mode: relay.mode,
    rounds: relay.rounds,
    manual: relay.manual,
    direction,
    goal,
    goal_source: goalSource,
  };
}

export function destinationFingerprint({
  provider,
  browserInstance,
  window,
  tab,
  targetId,
  conversationId,
  conversationTitle,
  conversationUrl,
} = {}) {
  return {
    provider: nonEmpty(provider),
    browser_instance: nonEmpty(browserInstance),
    window: nonEmpty(window),
    tab: nonEmpty(tab),
    target_id: nonEmpty(targetId),
    conversation_id: nonEmpty(conversationId),
    conversation_title: nonEmpty(conversationTitle),
    conversation_url: nonEmpty(conversationUrl),
  };
}

export function destinationMatches(expected = {}, actual = {}) {
  const fields = ["provider", "browser_instance", "window", "tab", "target_id", "conversation_id", "conversation_url"];
  return fields.every(field => !text(expected[field]) || text(expected[field]) === text(actual[field]));
}

export function messageHash({ origin, provider, conversationId, content, userPrompt = "" } = {}) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      origin: nonEmpty(origin),
      provider: nonEmpty(provider),
      conversation_id: nonEmpty(conversationId),
      content: text(content),
      user_prompt: text(userPrompt),
    }))
    .digest("hex");
}

export function createMessageEnvelope({
  origin,
  provider,
  conversationId,
  conversationTitle,
  relayId,
  turnIndex = 0,
  sourceMessageId = "",
  content,
  userPrompt = "",
  timestamp = new Date().toISOString(),
} = {}) {
  const body = text(content);
  if (!body) throw new Error("message content cannot be empty");
  const prompt = text(userPrompt);
  const hash = messageHash({ origin, provider, conversationId, content: body, userPrompt: prompt });
  return {
    origin: nonEmpty(origin, "web_peer"),
    provider: nonEmpty(provider),
    conversation_id: nonEmpty(conversationId),
    conversation_title: nonEmpty(conversationTitle),
    relay_id: nonEmpty(relayId),
    turn_index: Number.isInteger(turnIndex) ? turnIndex : 0,
    source_message_id: nonEmpty(sourceMessageId),
    message_hash: hash,
    timestamp,
    content: body,
    original_content: body,
    user_prompt: prompt,
  };
}

export function wasMessageConsumed(envelope, consumed = new Set()) {
  const key = envelope?.message_hash || messageHash(envelope || {});
  return consumed.has(key);
}

export function markMessageConsumed(envelope, consumed = new Set()) {
  const key = envelope?.message_hash || messageHash(envelope || {});
  consumed.add(key);
  return key;
}

export function userFacingRelayMode(config = {}) {
  if (config.mode === "one_shot") return "单次询问";
  if (config.mode === "continuous") return "持续连接";
  if (config.manual || config.rounds === 0) return "手动联机";
  return `${config.rounds} 轮往返`;
}
