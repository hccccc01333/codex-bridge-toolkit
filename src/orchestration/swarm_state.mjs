import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SWARM_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexChatGPTBridge", "swarms");
const MAX_MEMBERS = 32;
const MAX_EVENTS = 80;

function text(value) {
  return String(value ?? "").trim();
}

function now() {
  return new Date().toISOString();
}

export function normalizeSwarmId(value) {
  const id = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("swarm id must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

export function swarmFile(id) {
  return path.join(SWARM_DIR, `swarm-${normalizeSwarmId(id)}.json`);
}

export function newSwarmRecord({ id, name, cwd, workspace, watchdog = {} } = {}) {
  const swarmId = normalizeSwarmId(id);
  const timestamp = now();
  return {
    swarm_id: swarmId,
    name: text(name) || swarmId,
    cwd: text(cwd) || process.cwd(),
    workspace: workspace || null,
    members: [],
    watchdog: {
      interval_ms: Number(watchdog.interval_ms) || 15000,
      generation_timeout_ms: Number(watchdog.generation_timeout_ms) || 180000,
    },
    state: "preparing",
    stop_reason: null,
    events: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function mergeSwarm(record = {}) {
  const base = newSwarmRecord({
    id: record.swarm_id || "swarm-default",
    name: record.name,
    cwd: record.cwd,
    workspace: record.workspace,
    watchdog: record.watchdog,
  });
  return {
    ...base,
    ...record,
    swarm_id: base.swarm_id,
    members: Array.isArray(record.members) ? record.members.slice(0, MAX_MEMBERS) : [],
    events: Array.isArray(record.events) ? record.events.slice(-MAX_EVENTS) : [],
  };
}

export function readSwarm(id, { create = true } = {}) {
  const swarmId = normalizeSwarmId(id);
  fs.mkdirSync(SWARM_DIR, { recursive: true });
  try {
    return mergeSwarm(JSON.parse(fs.readFileSync(swarmFile(swarmId), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    const swarm = newSwarmRecord({ id: swarmId });
    writeSwarm(swarm);
    return swarm;
  }
}

export function writeSwarm(record) {
  const normalized = mergeSwarm(record);
  normalized.updated_at = now();
  fs.mkdirSync(SWARM_DIR, { recursive: true });
  fs.writeFileSync(swarmFile(normalized.swarm_id), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function listSwarms() {
  fs.mkdirSync(SWARM_DIR, { recursive: true });
  return fs.readdirSync(SWARM_DIR)
    .filter(name => /^swarm-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(name))
    .map(name => {
      try {
        return readSwarm(name.slice("swarm-".length, -".json".length), { create: false });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function findSwarmByName(name) {
  const wanted = text(name).toLocaleLowerCase();
  if (!wanted) return null;
  const matches = listSwarms().filter(swarm => String(swarm.name).toLocaleLowerCase() === wanted);
  if (matches.length > 1) throw new Error(`发现多个同名网页会话组：${name}`);
  return matches[0] || null;
}

export function appendSwarmEvent(swarmId, event = {}) {
  const swarm = readSwarm(swarmId);
  const entry = {
    event_id: event.event_id || `swarm-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: text(event.type || "EVENT").toUpperCase(),
    summary: text(event.summary || event.message).slice(0, 1200),
    created_at: now(),
  };
  swarm.events = [...swarm.events, entry].slice(-MAX_EVENTS);
  return writeSwarm(swarm);
}

function publicHealth(health) {
  if (!health) return null;
  return {
    state: health.state || "unknown",
    message: health.message || null,
    checked_at: health.checked_at || null,
    alert_count: Number(health.alert_count || 0),
    last_alert: health.last_alert || null,
  };
}

export function publicSwarmMember(member = {}) {
  const link = member.link || {};
  const watchdog = member.watchdog || {};
  const failure = member.failure || null;
  return {
    label: member.label || "未命名网页会话",
    state: member.state || link.state || "preparing",
    connected: Boolean(link.connected),
    provider: link.provider || member.provider || null,
    browser: link.browser || member.browser || null,
    window: link.window || member.window || null,
    tab: link.tab || member.tab || null,
    conversation: link.conversation || member.conversation || null,
    mode: link.mode || member.mode || null,
    direction: link.direction || member.direction || null,
    rounds: link.rounds ?? member.rounds ?? null,
    goal_status: link.goal_status || "none",
    run: link.run || null,
    workspace: link.workspace || null,
    browser_health: publicHealth(link.browser_health),
    watchdog: {
      lifecycle: watchdog.lifecycle || "not_started",
      state: watchdog.state || "unknown",
      checks: Number(watchdog.checks || 0),
      alert_count: Number(watchdog.alert_count || 0),
      last_alert: watchdog.last_alert || null,
      last_checked_at: watchdog.last_checked_at || null,
    },
    failure,
    recovery: failure ? "已暂停；请修复原标签页后明确恢复，不会自动换标签页或重发消息" : null,
  };
}

export function publicSwarm(swarm = {}) {
  const members = Array.isArray(swarm.members) ? swarm.members.map(publicSwarmMember) : [];
  const counts = members.reduce((result, member) => {
    result.total += 1;
    if (member.connected) result.connected += 1;
    if (["paused", "failed", "worker_unavailable", "duplicate_target"].includes(member.state)) result.paused += 1;
    if (member.state === "running") result.running += 1;
    if (member.state === "completed") result.completed += 1;
    return result;
  }, { total: 0, connected: 0, running: 0, paused: 0, completed: 0 });
  return {
    name: swarm.name,
    state: swarm.state || "preparing",
    workspace: swarm.workspace ? {
      name: swarm.workspace.name || swarm.workspace.root || null,
      github: Boolean(swarm.workspace.github),
      branch: swarm.workspace.branch || null,
      changes: Array.isArray(swarm.workspace.changes) ? swarm.workspace.changes.length : 0,
    } : null,
    counts,
    members,
    watchdog_policy: {
      interval_ms: swarm.watchdog?.interval_ms || 15000,
      generation_timeout_ms: swarm.watchdog?.generation_timeout_ms || 180000,
    },
    safety_policy: {
      independent_workers: true,
      independent_browser_targets: true,
      on_failure: "pause_group_and_member",
      auto_replace_tab: false,
      auto_resend: false,
      workspace_mode: "local_read_only_context",
    },
    stop_reason: swarm.stop_reason || null,
    updated_at: swarm.updated_at || null,
  };
}

export function memberByLabel(swarm, label) {
  const wanted = text(label).toLocaleLowerCase();
  const matches = (swarm.members || []).filter(member => String(member.label).toLocaleLowerCase() === wanted);
  if (matches.length > 1) throw new Error(`发现多个同名网页会话：${label}`);
  return matches[0] || null;
}

export function workerContextOf(swarm, member) {
  return {
    thread_id: member.worker_context,
    title: `${swarm.name} · ${member.label}`,
    source: "swarm_worker_context",
  };
}

export function maxMembers() {
  return MAX_MEMBERS;
}
