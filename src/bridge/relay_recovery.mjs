import crypto from "node:crypto";

function text(value) {
  return String(value ?? "").trim();
}

function asTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestampValue(value) {
  const normalized = asTimestamp(value);
  return normalized ? Date.parse(normalized) : null;
}

export function relayContentHash(value) {
  return crypto.createHash("sha256").update(text(value)).digest("hex");
}

export function isRelayEnvelope(value) {
  const body = text(value);
  return body.startsWith("【网页端 → Codex 搬运】")
    || body.startsWith("【Codex → 网页端】")
    || body.startsWith("[Web Peer Message]");
}

export function normalizePeerMessage(raw = {}, fallbackObservedAt = new Date().toISOString()) {
  const content = text(raw.content ?? raw.text);
  const displayedAt = asTimestamp(raw.displayed_at ?? raw.displayedAt ?? raw.timestamp);
  const observedAt = asTimestamp(raw.observed_at ?? raw.observedAt) || asTimestamp(fallbackObservedAt);
  return {
    available: Boolean(content),
    source_message_id: text(raw.source_message_id ?? raw.sourceMessageId ?? raw.id),
    content_hash: content ? relayContentHash(content) : "",
    content_length: content.length,
    displayed_at: displayedAt,
    observed_at: observedAt,
    timestamp_basis: displayedAt ? "displayed_at" : observedAt ? "observed_at" : "unavailable",
    relay_envelope: isRelayEnvelope(content),
  };
}

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  for (const key of ["text", "message", "body", "output"]) {
    if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
  }
  if (typeof item.content === "string" && item.content.trim()) return item.content.trim();
  if (!Array.isArray(item.content)) return "";
  return item.content.map(part => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return part.text || part.content || "";
    return "";
  }).join("").trim();
}

// App Server thread/read has evolved a few times. Keep this structural parser
// deliberately conservative: it considers only assistant/agent-like entries
// and returns metadata, never a transcript.
export function extractLatestCodexPeerMessage(value, observedAt = new Date().toISOString()) {
  const candidates = [];
  const seen = new Set();
  let order = 0;
  function visit(item, depth = 0) {
    if (item === null || item === undefined || depth > 12) return;
    if (typeof item !== "object") return;
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const kind = text(item.type || item.role || item.kind).toLowerCase();
    const looksLikePeer = /(agent|assistant|model)/.test(kind);
    const content = itemText(item);
    if (looksLikePeer && content) {
      candidates.push({
        id: text(item.id || item.itemId || item.item_id || item.messageId || item.message_id || item.turnId || item.turn_id),
        content,
        displayed_at: asTimestamp(item.createdAt || item.created_at || item.timestamp || item.time || item.updatedAt || item.updated_at),
        observed_at: observedAt,
        order: order++,
      });
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value);
  const usable = candidates.filter(candidate => !isRelayEnvelope(candidate.content));
  const latest = (usable.length ? usable : candidates).sort((left, right) => {
    const timeDelta = (timestampValue(left.displayed_at) || -1) - (timestampValue(right.displayed_at) || -1);
    return timeDelta || left.order - right.order;
  }).at(-1);
  return latest ? normalizePeerMessage(latest, observedAt) : normalizePeerMessage({}, observedAt);
}

export function createRelayHandoffId({ routeId, direction, sourceMessageId, content, provider = "" } = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    route_id: text(routeId),
    direction: text(direction),
    source_message_id: text(sourceMessageId),
    provider: text(provider),
    content_hash: relayContentHash(content),
  })).digest("hex");
}

function matchingHandoff(message, handoffs, direction) {
  return handoffs.find(handoff => {
    if (handoff?.direction !== direction) return false;
    if (message.source_message_id && handoff.source_message_id === message.source_message_id) return true;
    return message.content_hash && handoff.content_hash === message.content_hash;
  }) || null;
}

function latestByDirection(handoffs, direction) {
  return handoffs
    .filter(handoff => handoff?.direction === direction)
    .sort((left, right) => Date.parse(right.updated_at || right.created_at || 0) - Date.parse(left.updated_at || left.created_at || 0))[0] || null;
}

function decision({ status, interruptionSide = null, nextInitiator = null, reason, confidence = "low" } = {}) {
  return { status, interruption_side: interruptionSide, next_initiator: nextInitiator, reason, confidence };
}

// This reducer only chooses the next *safe* side. It never resends a message:
// the caller must explicitly resume/send after the result is presented.
export function reconcileRelay({ web = {}, codex = {}, handoffs = [] } = {}) {
  const webMessage = normalizePeerMessage(web);
  const codexMessage = normalizePeerMessage(codex);
  const records = Array.isArray(handoffs) ? handoffs : [];
  const webDelivered = matchingHandoff(webMessage, records, "web_to_codex");
  const codexDelivered = matchingHandoff(codexMessage, records, "codex_to_web");
  const webPending = webMessage.available && !webMessage.relay_envelope && !webDelivered;
  const codexPending = codexMessage.available && !codexMessage.relay_envelope && !codexDelivered;
  const latestOutbound = latestByDirection(records, "codex_to_web");

  if (webPending && codexPending) {
    const webTime = timestampValue(webMessage.displayed_at || webMessage.observed_at);
    const codexTime = timestampValue(codexMessage.displayed_at || codexMessage.observed_at);
    if (webTime === null || codexTime === null || webTime === codexTime) {
      return decision({
        status: "paused",
        reason: "两端都有未确认消息，但显示时间不足以安全判断先后；未自动重发。",
      });
    }
    const webIsNewer = webTime > codexTime;
    return decision({
      status: "recovery_ready",
      interruptionSide: webIsNewer ? "web_to_codex" : "codex_to_web",
      nextInitiator: webIsNewer ? "web" : "codex",
      reason: webIsNewer
        ? "网页端最后一条可见消息晚于 Codex，网页端消息尚未确认交给 Codex。"
        : "Codex 最后一条消息晚于网页端，Codex 消息尚未确认交给网页端。",
      confidence: webMessage.timestamp_basis === "displayed_at" && codexMessage.timestamp_basis === "displayed_at" ? "high" : "medium",
    });
  }

  if (webPending) {
    return decision({
      status: "recovery_ready",
      interruptionSide: "web_to_codex",
      nextInitiator: "web",
      reason: "网页端存在尚未确认交给 Codex 的可见消息。",
      confidence: webMessage.timestamp_basis === "displayed_at" ? "high" : "medium",
    });
  }

  if (codexPending) {
    return decision({
      status: "recovery_ready",
      interruptionSide: "codex_to_web",
      nextInitiator: "codex",
      reason: "Codex 存在尚未确认交给网页端的消息。",
      confidence: codexMessage.timestamp_basis === "displayed_at" ? "high" : "medium",
    });
  }

  if (latestOutbound && ["prepared", "submitted", "unknown"].includes(latestOutbound.state)) {
    return decision({
      status: "waiting_for_web",
      interruptionSide: "web_reply_pending",
      nextInitiator: "web",
      reason: "最近一次 Codex → 网页端交接尚未取得稳定网页回复；不会自动重复发送。",
      confidence: "high",
    });
  }

  return decision({
    status: "in_sync",
    reason: "两端最新可识别消息均已有交接记录。",
    confidence: "high",
  });
}
