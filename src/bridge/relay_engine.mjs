import {
  CONNECTION_STATES,
  createMessageEnvelope,
  markMessageConsumed,
  normalizeConnectionState,
  normalizeRelayConfig,
  wasMessageConsumed,
} from "./relay_contract.mjs";

const TERMINAL_RESULTS = new Set(["completed", "blocked", "repeated", "max_rounds", "continuous_safety_limit"]);

function text(value) {
  return String(value ?? "").trim();
}

function resultStatus(result) {
  const value = text(result?.status || result?.decision || "continue").toLowerCase();
  if (value === "complete" || value === "done" || value === "finished") return "completed";
  if (value === "block" || value === "blocked") return "blocked";
  if (value === "repeat" || value === "repeated") return "repeated";
  if (value === "max-rounds" || value === "max_rounds") return "max_rounds";
  if (value === "continuous-safety-limit" || value === "continuous_safety_limit") return "continuous_safety_limit";
  return "continue";
}

export function createRelayEngine({
  config,
  relayId = "",
  verifyDestination = async () => undefined,
  sendMessage = async envelope => envelope,
  receiveMessage = async () => null,
  executeRound = async () => ({ status: "completed" }),
  safetyLimit = 1000,
  onStateChange = () => undefined,
} = {}) {
  const normalized = normalizeRelayConfig(config);
  const consumed = new Set();
  const state = {
    relay_id: text(relayId),
    state: normalized.manual ? "ready" : "connected",
    mode: normalized.mode,
    rounds: normalized.rounds,
    direction: normalized.direction,
    goal: normalized.goal,
    round: 0,
    last_stop: null,
    last_message_hash: null,
  };

  async function transition(next, reason = "") {
    state.state = normalizeConnectionState(next);
    state.last_stop = reason || null;
    await onStateChange({ ...state });
    return { ...state };
  }

  async function failClosed(reason, trigger = "destination_mismatch") {
    await transition("paused", reason);
    return { ...state, status: "paused", trigger, reason };
  }

  async function verify() {
    try {
      await verifyDestination();
      return true;
    } catch (error) {
      await failClosed(String(error), error.code || "destination_mismatch");
      return false;
    }
  }

  async function send({ content, userPrompt = "", provider, conversationId, conversationTitle, sourceMessageId = "", turnIndex = state.round } = {}) {
    if (["paused", "completed", "blocked", "disconnected"].includes(state.state)) {
      return { sent: false, state: state.state, reason: state.last_stop || "relay is not active" };
    }
    if (!(await verify())) return { sent: false, state: state.state, reason: state.last_stop };
    const envelope = createMessageEnvelope({
      origin: "codex",
      provider,
      conversationId,
      conversationTitle,
      relayId: state.relay_id,
      sourceMessageId,
      turnIndex,
      content,
      userPrompt,
    });
    if (wasMessageConsumed(envelope, consumed)) return failClosed("duplicate outgoing message", "duplicate_loop");
    let result;
    try {
      result = await sendMessage(envelope);
    } catch (error) {
      await failClosed(String(error), error.code || "send_failed");
      throw error;
    }
    // A failed delivery must remain retryable after an explicit resume. Do not
    // consume the envelope until the host adapter confirms the send completed.
    markMessageConsumed(envelope, consumed);
    if (state.mode === "one_shot") await transition("completed", "one-shot message delivered");
    return { sent: true, envelope, result, state: { ...state } };
  }

  async function receive({ provider, conversationId, conversationTitle, sourceMessageId = "", turnIndex = state.round } = {}) {
    if (["paused", "completed", "blocked", "disconnected"].includes(state.state)) {
      return { received: false, state: state.state, reason: state.last_stop || "relay is not active" };
    }
    if (!(await verify())) return { received: false, state: state.state, reason: state.last_stop };
    const result = await receiveMessage();
    if (!result?.content) return { received: false, new_message: false, state: { ...state } };
    const envelope = createMessageEnvelope({
      origin: "web_peer",
      provider,
      conversationId,
      conversationTitle,
      relayId: state.relay_id,
      sourceMessageId: result.source_message_id || sourceMessageId,
      turnIndex,
      content: result.content,
    });
    if (wasMessageConsumed(envelope, consumed)) return { received: false, new_message: false, state: { ...state } };
    markMessageConsumed(envelope, consumed);
    return { received: true, new_message: true, envelope, result, state: { ...state } };
  }

  async function run({ context = "", constraints = [], ...input } = {}) {
    if (["paused", "completed", "blocked", "disconnected"].includes(state.state)) {
      return {
        started: false,
        status: state.state,
        state: { ...state },
        reason: state.last_stop || "relay is not active; resume the link explicitly first",
      };
    }
    if (state.mode === "one_shot" || state.rounds === 0) {
      return { started: false, state: { ...state }, reason: "relay is connected for manual or one-shot use" };
    }
    const goal = text(input.goal || state.goal);
    if (!goal) return failClosed("continuous or bounded Brain-Hand mode requires a goal", "goal_required");
    state.goal = goal;
    await transition("running");
    const bounded = state.mode === "bounded";
    const limit = bounded
      ? state.rounds
      : Math.max(1, Number(input.safety_limit ?? safetyLimit) || 1000);
    for (let index = 0; index < limit; index += 1) {
      if (state.state === "paused" || state.state === "disconnected" || state.state === "blocked" || state.state === "completed") {
        return { started: true, status: state.state, ...state };
      }
      if (!(await verify())) return { started: true, ...state };
      state.round = index;
      const result = await executeRound({ ...input, context, constraints, round: index, goal });
      const status = resultStatus(result);
      if (TERMINAL_RESULTS.has(status)) {
        await transition(status === "max_rounds" ? "paused" : status, status);
        return { started: true, status, result, ...state };
      }
    }
    await transition("paused", bounded ? "round limit reached" : "continuous safety limit reached");
    return {
      started: true,
      status: bounded ? "max_rounds" : "continuous_safety_limit",
      safety_limit: bounded ? undefined : limit,
      ...state,
    };
  }

  async function pause(reason = "user pause") {
    return transition("paused", reason);
  }

  async function stop(reason = "user stop") {
    return transition("disconnected", reason);
  }

  async function resume(reason = "user resume") {
    if (state.state !== "paused") {
      return { resumed: false, state: { ...state }, reason: "only a paused relay can be resumed" };
    }
    const nextState = state.mode === "bounded" && state.rounds === 0 ? "ready" : "connected";
    await transition(nextState, reason);
    return { resumed: true, state: { ...state } };
  }

  function status() {
    return { ...state, supported_states: [...CONNECTION_STATES] };
  }

  function setGoal(goal) {
    state.goal = text(goal);
    return { ...state };
  }

  return { send, receive, run, pause, stop, resume, status, setGoal };
}
