import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ROUTE_ID = "default";
const ROUTE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexChatGPTBridge", "routes");
const MAX_EVENTS = 80;
const MAX_PENDING_EVENTS = 40;
const routeQueues = new Map();

function now() {
  return new Date().toISOString();
}

function clip(value, limit = 1200) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

export function normalizeRouteId(value = DEFAULT_ROUTE_ID) {
  const id = String(value || DEFAULT_ROUTE_ID).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("route_id must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

export function routeIdOf(args = {}) {
  return normalizeRouteId(args.route_id ?? args.routeId ?? args.session_id ?? args.sessionId ?? DEFAULT_ROUTE_ID);
}

function routeFile(routeId) {
  return path.join(ROUTE_DIR, `route-${normalizeRouteId(routeId)}.json`);
}

export function newRouteRecord(routeId, fields = {}) {
  const id = normalizeRouteId(routeId);
  const timestamp = now();
  return {
    route_id: id,
    name: String(fields.name || id),
    codex_thread_id: fields.codex_thread_id || fields.codexThreadId || null,
    session_id: fields.session_id || fields.sessionId || id,
    target_id: fields.target_id || fields.targetId || null,
    conversation_id: fields.conversation_id || fields.conversationId || null,
    status: fields.status || "idle",
    round: Number.isInteger(Number(fields.round)) ? Number(fields.round) : 0,
    last_action: fields.last_action || null,
    latest_task: fields.latest_task || null,
    latest_report: fields.latest_report || null,
    latest_review: fields.latest_review || null,
    queue: {
      pending_count: 0,
      active: null,
      completed: 0,
      failed: 0,
      last_event: null,
    },
    events: [],
    created_at: fields.created_at || timestamp,
    updated_at: timestamp,
  };
}

function mergeRoute(routeId, parsed = {}) {
  const base = newRouteRecord(routeId);
  const queue = { ...base.queue, ...(parsed.queue || {}) };
  queue.pending = Array.isArray(queue.pending) ? queue.pending.slice(-MAX_PENDING_EVENTS) : [];
  queue.pending_count = queue.pending.length;
  return {
    ...base,
    ...parsed,
    route_id: normalizeRouteId(routeId),
    queue,
    events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
  };
}

export function readRoute(routeId = DEFAULT_ROUTE_ID, { create = true } = {}) {
  const id = normalizeRouteId(routeId);
  fs.mkdirSync(ROUTE_DIR, { recursive: true });
  try {
    return mergeRoute(id, JSON.parse(fs.readFileSync(routeFile(id), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    const route = newRouteRecord(id);
    writeRoute(route);
    return route;
  }
}

export function writeRoute(route) {
  const normalized = mergeRoute(route.route_id, route);
  normalized.updated_at = now();
  fs.mkdirSync(ROUTE_DIR, { recursive: true });
  fs.writeFileSync(routeFile(normalized.route_id), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function listRoutes() {
  fs.mkdirSync(ROUTE_DIR, { recursive: true });
  return fs.readdirSync(ROUTE_DIR)
    .filter(name => /^route-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(name))
    .map(name => {
      try {
        const id = name.slice("route-".length, -".json".length);
        return readRoute(id, { create: false });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function routeSummary(route) {
  return {
    route_id: route.route_id,
    name: route.name,
    codex_thread_id: route.codex_thread_id || null,
    session_id: route.session_id || null,
    target_id: route.target_id || null,
    conversation_id: route.conversation_id || null,
    status: route.status || "idle",
    round: route.round || 0,
    last_action: route.last_action || null,
    latest_task: route.latest_task || null,
    latest_report: route.latest_report || null,
    latest_review: route.latest_review || null,
    queue: {
      pending_count: route.queue?.pending_count || 0,
      active: route.queue?.active || null,
      completed: route.queue?.completed || 0,
      failed: route.queue?.failed || 0,
      last_event: route.queue?.last_event || null,
    },
    updated_at: route.updated_at || null,
  };
}

export function updateRoute(routeId, patch = {}) {
  const route = readRoute(routeId);
  const updated = writeRoute({ ...route, ...patch, route_id: route.route_id });
  return updated;
}

export function appendRouteEvent(routeId, event = {}) {
  const route = readRoute(routeId);
  const entry = {
    event_id: event.event_id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: String(event.type || "EVENT").toUpperCase(),
    summary: clip(event.summary || event.message || ""),
    data: event.data === undefined ? undefined : clip(JSON.stringify(event.data), 3000),
    created_at: now(),
  };
  route.events = [...(route.events || []), entry].slice(-MAX_EVENTS);
  route.queue = {
    ...route.queue,
    last_event: { event_id: entry.event_id, type: entry.type, created_at: entry.created_at },
  };
  return writeRoute(route);
}

export function enqueueRouteEvent(routeId, event = {}) {
  const route = readRoute(routeId);
  const entry = {
    event_id: event.event_id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: String(event.type || "EVENT").toUpperCase(),
    summary: clip(event.summary || event.message || ""),
    data: event.data === undefined ? undefined : clip(JSON.stringify(event.data), 3000),
    created_at: now(),
  };
  const pending = Array.isArray(route.queue?.pending) ? route.queue.pending : [];
  route.queue = {
    ...route.queue,
    pending: [...pending, entry].slice(-MAX_PENDING_EVENTS),
    pending_count: Math.min(pending.length + 1, MAX_PENDING_EVENTS),
    last_event: { event_id: entry.event_id, type: entry.type, created_at: entry.created_at },
  };
  route.events = [...(route.events || []), entry].slice(-MAX_EVENTS);
  return writeRoute(route);
}

export function routeQueueState(routeId) {
  const runtime = routeQueues.get(normalizeRouteId(routeId));
  return runtime ? { queued: true } : { queued: false };
}

function removeQueuedAction(pending, action) {
  const index = pending.findIndex(item => item.type === "ACTION_QUEUED" && item.summary === action);
  if (index < 0) return pending;
  return [...pending.slice(0, index), ...pending.slice(index + 1)];
}

export function enqueueRouteAction(routeId, action, handler, { allowPaused = false } = {}) {
  const id = normalizeRouteId(routeId);
  const previous = routeQueues.get(id) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    let route = readRoute(id);
    if (route.status === "paused" && !allowPaused) {
      const pending = removeQueuedAction(Array.isArray(route.queue?.pending) ? route.queue.pending : [], action);
      writeRoute({
        ...route,
        queue: {
          ...route.queue,
          pending,
          pending_count: pending.length,
        },
      });
      const error = new Error(`route is paused: ${id}`);
      error.code = "ROUTE_PAUSED";
      throw error;
    }
    const event = {
      event_id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: action,
      summary: `started ${action}`,
      created_at: now(),
    };
    const pending = removeQueuedAction(Array.isArray(route.queue?.pending) ? route.queue.pending : [], action);
    const pendingCount = pending.length;
    route = writeRoute({
      ...route,
      status: route.status === "paused" ? "paused" : "running",
      last_action: action,
      queue: { ...route.queue, pending, pending_count: pendingCount, active: event, last_event: event },
      events: [...(route.events || []), event].slice(-MAX_EVENTS),
    });
    try {
      const result = await handler(route);
      route = readRoute(id);
      const failed = Boolean(result?.isError);
      writeRoute({
        ...route,
        status: failed ? "failed" : route.status,
        queue: {
          ...route.queue,
          active: null,
          completed: Number(route.queue?.completed || 0) + (failed ? 0 : 1),
          failed: Number(route.queue?.failed || 0) + (failed ? 1 : 0),
        },
      });
      return result;
    } catch (error) {
      route = readRoute(id);
      writeRoute({
        ...route,
        status: "failed",
        queue: { ...route.queue, active: null, failed: Number(route.queue?.failed || 0) + 1 },
      });
      throw error;
    }
  });
  routeQueues.set(id, next);
  next.finally(() => {
    if (routeQueues.get(id) === next) routeQueues.delete(id);
  }).catch(() => undefined);
  return next;
}
