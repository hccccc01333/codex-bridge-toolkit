#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROUTE_ID,
  appendRouteEvent,
  enqueueRouteAction,
  enqueueRouteEvent,
  listRoutes,
  newRouteRecord,
  normalizeRouteId,
  readRoute,
  routeIdOf,
  routeQueueState,
  routeSummary,
  readWebDelivery,
  removeWebDelivery,
  updateRoute,
  writeWebDelivery,
  writeRoute,
} from "./control_plane.mjs";
import {
  compileProtocolMessage,
  completionProof,
  enforceEvidenceFirst,
  taskIRFromArgs,
} from "./protocol.mjs";
import {
  DEFAULT_MAX_ROUNDS as STOP_DEFAULT_MAX_ROUNDS,
  HARD_MAX_ROUNDS as STOP_HARD_MAX_ROUNDS,
  detectRepeated,
  fingerprint,
  maxRoundsOf as stopMaxRoundsOf,
  roundLimitReached,
} from "../src/orchestration/stop_policy.mjs";
import {
  conversationIdFromUrl,
  safeConversationUrl,
} from "../src/browser/conversation_router.mjs";
import {
  DEFAULT_BRAIN_PROVIDER,
  getBrainProvider,
  listBrainProviders,
  normalizeBrainProvider,
  providerMatchesUrl,
} from "../src/adapters/web_brain.mjs";
import {
  DEFAULT_EXECUTOR_PROVIDER,
  codexLaunchArgs,
  executorModelOf,
  executorEndpointOf,
  normalizeExecutorAgent,
  executorProfileOf as codexProfileOf,
  getExecutorProvider,
  listExecutorProviders,
  normalizeCodexProfile,
  normalizeExecutorProvider,
} from "../src/adapters/executor.mjs";
import { createCodexAdapter, codexThreadIdFromUrl } from "../src/adapters/codex.mjs";
import { createOpenCodeAdapter } from "../src/adapters/opencode.mjs";
import { getWebLLMAdapter } from "../src/adapters/provider_registry.mjs";
import { createRuntimeRunner } from "../src/runtime/runner.mjs";
import {
  createMessageEnvelope,
  normalizeRelayConfig,
  userFacingRelayMode,
} from "../src/bridge/relay_contract.mjs";
import { compileUserGoal } from "../src/bridge/goal_compiler.mjs";
import { createRelayEngine } from "../src/bridge/relay_engine.mjs";
import {
  appendSwarmEvent,
  findSwarmByName,
  listSwarms,
  maxMembers,
  memberByLabel,
  newSwarmRecord,
  publicSwarm,
  readSwarm,
  workerContextOf,
  writeSwarm,
} from "../src/orchestration/swarm_state.mjs";
import {
  WEB_PROMPT_MAX_CHARS,
  WEB_REPLY_MIN_STABLE_MS,
  WEB_REPLY_STABLE_POLLS,
  compactWebPrompt,
  createReplyTracker,
  observeReply,
} from "../src/bridge/web_reply_tracker.mjs";
import { createPanelServer } from "./panel_server.mjs";
import { TOOLKIT_SERIES_VERSION, listToolkits } from "../src/toolkits/registry.mjs";
import { inspectGithubWorkspace } from "../src/toolkits/github_workspace.mjs";
import { scanBrowser } from "../src/toolkits/browser_watchdog.mjs";
import { hostCompatibilityStatus } from "../src/toolkits/host_compatibility.mjs";
import { inspectArtifactWorkspace, readArtifactContext } from "../src/toolkits/artifact_workspace.mjs";
import { createRouteWorkerPool } from "../src/control_plane/route_worker_pool.mjs";
import {
  browserInstanceFromEndpoint,
  discoveryText,
  publicBrowserChoices,
  selectTab,
  selectTabInWindow,
  selectWindow,
  undebuggableBrowserInstance,
} from "../src/browser/discovery.mjs";
import {
  clip as brainClip,
  decisionFromReply,
  firstNonEmpty,
  newBrainState as createBrainState,
  normalizeReport as normalizeBrainReport,
  planPrompt,
  recordReport as recordBrainReport,
  recordTask as recordBrainTask,
  reportPrompt,
  reviewPrompt,
  stringList as brainStringList,
} from "../src/orchestration/brain_hand.mjs";

const DEFAULT_PORT = 9222;
const SERVER_NAME = "chatgpt-web-bridge";
const SERVER_VERSION = "0.1.0";
const MCP_UI_RESOURCE_URI = "ui://codex-web-bridge/control-panel-v1.html";
const MCP_UI_RESOURCE_MIME = "text/html;profile=mcp-app";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_ROUTE_WORKER = process.env.CODEX_BRIDGE_ROUTE_WORKER === "1";
const MCP_UI_RESOURCE_PATH = path.join(SERVER_ROOT, "ui", "mcp_control_panel.html");
const DEFAULT_MAX_ROUNDS = STOP_DEFAULT_MAX_ROUNDS;
const HARD_MAX_ROUNDS = STOP_HARD_MAX_ROUNDS;
const DEFAULT_SESSION_ID = "default";
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexChatGPTBridge", "sessions");

function brainProviderSchema({ includeDefault = false } = {}) {
  const schema = {
    type: "string",
    enum: listBrainProviders().map(provider => provider.id),
    description: "Select the visible web planning brain. ChatGPT Web is the default; DeepSeek Web is available for Chinese reasoning and cost-sensitive tasks.",
  };
  if (includeDefault) schema.default = DEFAULT_BRAIN_PROVIDER;
  return schema;
}

function executorProviderSchema({ includeDefault = false } = {}) {
  const schema = {
    type: "string",
    enum: listExecutorProviders().map(provider => provider.id),
    description: "Select the local executor. ChatGPT Luna is the default; DeepSeek API exposes Pro/Flash, and OpenCode uses a user-started local HTTP server.",
  };
  if (includeDefault) schema.default = DEFAULT_EXECUTOR_PROVIDER;
  return schema;
}

function executorModelSchema() {
  const providers = listExecutorProviders();
  if (providers.some(provider => provider.allow_custom_model)) {
    return {
      type: "string",
      description: "Optional executor model. OpenCode accepts the configured provider/model name; leave empty to inherit its local default.",
    };
  }
  return {
    type: "string",
    enum: [...new Set(providers.flatMap(provider => provider.models))],
    description: "Optional executor model. Leave empty to use the selected provider's default.",
  };
}

function executorProfileSchema() {
  return {
    type: "string",
    description: "Optional local Codex profile override. Leave empty to use the selected executor mapping; codex_current inherits the active Codex configuration.",
  };
}

let socket = null;
let target = null;
let commandId = 0;
const pending = new Map();
let selectedConversation = null;
let activeTargetId = null;
let activeSessionId = DEFAULT_SESSION_ID;
let activeSession = null;
let activeRouteId = DEFAULT_ROUTE_ID;
let activeRoute = null;
const codexAdapters = new Map();
let activeBridgeLink = null;
let activeRelayEngine = null;
let activeBridgeRun = null;
let activePanel = null;
let pendingDedicatedLaunch = null;
const watchdogRuns = new Map();
const pendingBrainTargetCreation = new Map();
const execFileAsync = promisify(execFile);
const routeWorkerPool = IS_ROUTE_WORKER ? null : createRouteWorkerPool({
  script: fileURLToPath(import.meta.url),
  cwd: SERVER_ROOT,
  env: process.env,
});

process.once("exit", () => routeWorkerPool?.closeAll());

function normalizeHostCodexContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const threadId = String(raw.thread_id || raw.threadId || raw.codex_thread_id || raw.codexThreadId || "").trim();
  const title = String(raw.title || raw.name || raw.conversation_title || raw.conversationTitle || "").trim();
  if (!threadId && !title) return null;
  return {
    thread_id: threadId || null,
    title: title || null,
    source: "codex_host_context",
  };
}

function executorEndpointSchema() {
  return {
    type: "string",
    description: "OpenCode server URL, for example http://127.0.0.1:4096. Leave empty to use OPENCODE_SERVER_URL or the local default.",
  };
}

function executorAgentSchema() {
  return {
    type: "string",
    description: "Optional OpenCode agent name. Leave empty to use OpenCode's default agent.",
  };
}

function hostCodexContextOf(args = {}) {
  return normalizeHostCodexContext(args.__host_codex_context || args.host_codex_context || args.codex_context);
}

function codexBindingView(route = activeRoute) {
  const binding = route?.codex_binding;
  if (binding?.source === "current_codex_conversation") {
    return {
      state: "bound",
      source: "current_codex_conversation",
      label: binding.title || "当前 Codex 对话",
      verified: Boolean(binding.verified),
    };
  }
  if (binding?.source === "external_codex_thread") {
    return {
      state: "external_thread",
      source: "external_codex_thread",
      label: "指定的其他 Codex 对话（未绑定为当前 Worker）",
      verified: false,
    };
  }
  if (route?.codex_thread_id) {
    return {
      state: "managed_worker",
      source: "managed_worker",
      label: "插件托管的 Codex Worker",
      verified: Boolean(binding?.verified),
    };
  }
  return {
    state: "unbound",
    source: "host_context_unavailable",
    label: "尚未绑定当前 Codex 对话",
    verified: false,
  };
}

function hostCodexContextFromRequest(message = {}) {
  const params = message.params || {};
  const meta = params._meta || params.meta || message._meta || {};
  return normalizeHostCodexContext(
    meta.codex_context
    || meta.codexContext
    || params.codex_context
    || params.codexContext
    || params.host_context
    || params.hostContext,
  );
}

let brainState = createBrainState(DEFAULT_MAX_ROUNDS);

const runtimeRunner = createRuntimeRunner({
  getState: () => brainState,
  planner: args => brainPlan(args),
  executor: context => codexThreadTurn({ ...context, text: context.task, task: context.task }),
  reporter: context => executorReport({
    ...context,
    report: context.report_text,
    changes: context.report?.changes,
    tests: context.report?.tests,
    blockers: context.report?.blockers,
    evidence: context.report?.evidence,
  }),
  reviewer: context => {
    const { report: _report, report_text: _reportText, execution: _execution, plan: _plan, ...reviewArgs } = context;
    return brainReview(reviewArgs);
  },
  persist: () => persistActiveSession(),
  emit: event => {
    if (!activeRouteId) return;
    activeRoute = appendRouteEvent(activeRouteId, event);
    syncActiveRoute();
  },
  onStop: ({ decision }) => {
    brainState.latestReview = {
      round: decision.round || brainState.round,
      status: decision.status,
      reason: decision.reason || "runtime stopped",
      task: decision.task || brainState.latestPlan?.task || "",
      constraints: decision.constraints || brainState.latestPlan?.constraints || [],
      acceptance: decision.acceptance || brainState.latestPlan?.acceptance || [],
      evidence: decision.evidence || brainState.latestPlan?.evidence || [],
    };
  },
  advance: (state, review, nextRound) => {
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
    recordBrainTask(state, nextPlan);
    return nextPlan;
  },
});

function normalizeSessionId(value = DEFAULT_SESSION_ID) {
  const id = String(value || DEFAULT_SESSION_ID).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("session_id must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

function sessionIdOf(args = {}) {
  return normalizeSessionId(args.session_id ?? args.sessionId ?? DEFAULT_SESSION_ID);
}

function brainProviderIdOf(args = {}, fallback = DEFAULT_BRAIN_PROVIDER) {
  return normalizeBrainProvider(args.brain_provider ?? args.brainProvider ?? args.provider ?? fallback);
}

function brainProviderOf(args = {}, fallback = undefined) {
  return getBrainProvider(brainProviderIdOf(args, fallback || activeSession?.brain_provider || activeRoute?.brain_provider || DEFAULT_BRAIN_PROVIDER));
}

function executorProviderIdOf(args = {}, fallback = DEFAULT_EXECUTOR_PROVIDER) {
  return normalizeExecutorProvider(args.executor_provider ?? args.executorProvider ?? fallback);
}

function executorProviderOf(args = {}, fallback = undefined) {
  return getExecutorProvider(executorProviderIdOf(args, fallback || activeRoute?.executor_provider || DEFAULT_EXECUTOR_PROVIDER));
}

function executorModelFor(args = {}, provider = executorProviderOf(args)) {
  return executorModelOf(provider, args.executor_model ?? args.executorModel ?? activeRoute?.executor_model);
}

function executorProfileFor(args = {}, provider = executorProviderOf(args), model = undefined) {
  const requested = args.executor_profile ?? args.executorProfile;
  const selected = requested !== undefined ? requested : activeRoute?.executor_profile || "";
  const explicit = normalizeCodexProfile(selected);
  if (explicit) return explicit;
  const resolvedModel = model === undefined ? executorModelFor(args, provider) : model;
  return codexProfileOf(provider, "", resolvedModel);
}

function executorEndpointFor(args = {}, provider = executorProviderOf(args)) {
  const requested = args.executor_endpoint ?? args.executorEndpoint;
  const selected = requested !== undefined ? requested : activeRoute?.executor_endpoint || "";
  return executorEndpointOf(provider, selected);
}

function executorAgentFor(args = {}, provider = executorProviderOf(args)) {
  if (provider.kind !== "opencode") return "";
  const requested = args.executor_agent ?? args.executorAgent;
  const selected = requested !== undefined ? requested : activeRoute?.executor_agent || "";
  return normalizeExecutorAgent(selected);
}

function newSessionState(sessionId, name = "", brainProvider = DEFAULT_BRAIN_PROVIDER) {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    name: firstNonEmpty(name, sessionId),
    brain_provider: brainProviderIdOf({ brain_provider: brainProvider }),
    conversation: null,
    target_id: null,
    target_url: null,
    brain_state: newBrainState(),
    created_at: now,
    updated_at: now,
  };
}

function sessionFile(sessionId) {
  return path.join(SESSION_DIR, `session-${normalizeSessionId(sessionId)}.json`);
}

function readSession(sessionId, create = true) {
  const id = normalizeSessionId(sessionId);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
    return {
      ...newSessionState(id),
      ...parsed,
      session_id: id,
      brain_provider: brainProviderIdOf(parsed, DEFAULT_BRAIN_PROVIDER),
      brain_state: { ...newBrainState(), ...(parsed.brain_state || {}) },
    };
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    const session = newSessionState(id);
    writeSession(session);
    return session;
  }
}

function writeSession(session) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  session.updated_at = new Date().toISOString();
  fs.writeFileSync(sessionFile(session.session_id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function activateSession(args = {}) {
  const id = sessionIdOf(args);
  activeSession = readSession(id);
  const previousProvider = activeSession.brain_provider || DEFAULT_BRAIN_PROVIDER;
  const nextProvider = brainProviderIdOf(args, previousProvider);
  if (previousProvider !== nextProvider) {
    if (activeSession.brain_state?.goal && !args.force) {
      const error = new Error(`cannot switch brain_provider during an active task: ${previousProvider} -> ${nextProvider}; reset the task or pass force=true`);
      error.code = "BRAIN_PROVIDER_SWITCH_ACTIVE";
      throw error;
    }
    activeSession.conversation = null;
    activeSession.target_id = null;
    activeSession.target_url = null;
    selectedConversation = null;
    activeTargetId = null;
    closeSocket();
  }
  activeSession.brain_provider = nextProvider;
  activeSessionId = id;
  brainState = activeSession.brain_state;
  selectedConversation = activeSession.conversation;
  return activeSession;
}

function ensureActiveSession(args = {}) {
  return ensureActiveRoute(args);
}

function persistActiveSession() {
  if (!activeSession) return;
  activeSession.brain_state = brainState;
  activeSession.conversation = selectedConversation;
  if (activeTargetId) activeSession.target_id = activeTargetId;
  if (target?.url) activeSession.target_url = target.url;
  writeSession(activeSession);
  if (activeRoute) syncActiveRoute();
}

function sessionSummary(session) {
  const brain = session.brain_state || newBrainState();
  return {
    session_id: session.session_id,
    name: session.name || session.session_id,
    brain_provider: session.brain_provider || DEFAULT_BRAIN_PROVIDER,
    conversation: session.conversation || null,
    target_id: session.target_id || null,
    round: brain.round || 0,
    max_rounds: brain.maxRounds || DEFAULT_MAX_ROUNDS,
    goal: brain.goal || "",
    updated_at: session.updated_at || null,
  };
}

function listStoredSessions() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return fs.readdirSync(SESSION_DIR)
    .filter(name => /^session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(name))
    .map(name => {
      try { return sessionSummary(JSON.parse(fs.readFileSync(path.join(SESSION_DIR, name), "utf8"))); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function createSession(args = {}) {
  const rawId = args.session_id ?? args.sessionId;
  if (!String(rawId || "").trim()) {
    return jsonResult("session_id is required when creating a session", { created: false }, true);
  }
  let id;
  try { id = normalizeSessionId(rawId); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  const file = sessionFile(id);
  if (fs.existsSync(file)) {
    return jsonResult(`session already exists: ${id}`, { created: false, session_id: id }, true);
  }
  let brainProvider;
  try { brainProvider = brainProviderIdOf(args); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  const session = newSessionState(id, args.name, brainProvider);
  writeSession(session);
  activeSession = session;
  activeSessionId = id;
  brainState = session.brain_state;
  selectedConversation = null;
  activeTargetId = null;
  return jsonResult(`session created: ${id}`, { created: true, session: sessionSummary(session) });
}

function listSessions() {
  return jsonResult("stored bridge sessions", {
    active_session_id: activeSessionId,
    sessions: listStoredSessions(),
  });
}

function brainProviderList() {
  return jsonResult("supported web brain providers", {
    default_provider: DEFAULT_BRAIN_PROVIDER,
    providers: listBrainProviders(),
    extension_point: "Add a provider profile under src/adapters/web_brain.mjs; browser interaction remains visible-CDP only.",
  });
}

function executorProviderList() {
  return jsonResult("supported local executor hosts", {
    default_provider: DEFAULT_EXECUTOR_PROVIDER,
    providers: listExecutorProviders(),
    note: "Codex uses its local App Server profile; OpenCode uses a user-started local serve endpoint. Credentials remain managed by the host or environment and are never collected by the bridge.",
  });
}

function publicToolkitLink(route) {
  const session = listStoredSessions().find(item => item.session_id === route.session_id);
  const conversation = session?.conversation;
  const binding = route.codex_binding;
  return {
    label: route.name || session?.name || "未命名连接",
    state: route.status || "idle",
    brain_provider: route.brain_provider || DEFAULT_BRAIN_PROVIDER,
    executor_provider: route.executor_provider || DEFAULT_EXECUTOR_PROVIDER,
    executor_model: route.executor_model || null,
    executor_endpoint: route.executor_endpoint || null,
    conversation: conversation ? {
      title: conversation.title || "当前网页对话",
      url: conversation.url || null,
    } : null,
    codex: binding ? {
      label: binding.title || (binding.source === "managed_worker" ? "插件托管 Worker" : "当前 Codex 对话"),
      source: binding.source || "unknown",
      verified: Boolean(binding.verified),
    } : {
      label: "尚未绑定 Codex 对话",
      source: "unbound",
      verified: false,
    },
    workspace: route.workspace ? {
      name: route.workspace.name || route.workspace.root || null,
      github: Boolean(route.workspace.github),
      branch: route.workspace.branch || null,
      changes: Array.isArray(route.workspace.changes) ? route.workspace.changes.length : 0,
    } : null,
    browser_health: route.browser_health ? {
      state: route.browser_health.state || "unknown",
      message: route.browser_health.message || null,
      checked_at: route.browser_health.checked_at || null,
    } : null,
    round: Number(route.round || session?.round || 0),
    updated_at: route.updated_at || session?.updated_at || null,
  };
}

function bridgeLinkList() {
  return listRoutes().map(publicToolkitLink).sort((left, right) => left.label.localeCompare(right.label));
}

function toolkitCatalog() {
  return jsonResult("Codex Bridge toolkit series", {
    series_version: TOOLKIT_SERIES_VERSION,
    default_toolkit: "web-bridge",
    toolkits: listToolkits(),
    links: bridgeLinkList(),
    parallel_execution: {
      enabled: !IS_ROUTE_WORKER,
      isolation: "one MCP worker process per Codex host context",
      note: "独立 Codex 对话使用独立 worker；同一连接内仍按 route 串行化操作。",
    },
    defaults: {
      browser_automation: "visible_cdp_only",
      github_actions: "read_only",
      credential_handling: "never_collect_passwords_or_tokens",
    },
  });
}

function toolkitStatus() {
  return jsonResult("Codex Bridge toolkit status", {
    series_version: TOOLKIT_SERIES_VERSION,
    toolkits: listToolkits().map(toolkit => ({
      id: toolkit.id,
      display_name: toolkit.display_name,
      status: toolkit.status,
      tools: toolkit.tools,
    })),
    links: bridgeLinkList(),
    active_link: publicBridgeLink(),
    watchdogs: [...watchdogRuns.values()].map(watchdogPublicView),
    parallel_execution: routeWorkerPool ? {
      enabled: true,
      worker_processes: routeWorkerPool.status().count,
      isolation: "one MCP worker process per Codex host context",
    } : {
      enabled: false,
      role: "route worker",
    },
  });
}

function watchdogPublicView(run) {
  return {
    name: run.name,
    provider: run.provider,
    port: run.port,
    interval_ms: run.interval_ms,
    lifecycle: run.lifecycle,
    state: run.state,
    checks: run.checks,
    alert_count: run.alert_count,
    last_alert: run.last_alert || null,
    started_at: run.started_at,
    last_checked_at: run.last_checked_at,
    last_result: run.last_result || null,
    error: run.error || null,
  };
}

function watchdogArgs(args = {}) {
  const tab = String(args.tab || "").trim();
  return {
    port: args.port,
    provider: args.provider || args.brain_provider || DEFAULT_BRAIN_PROVIDER,
    target_id: args.target_id || args.targetId,
    target_title: args.target_title || args.targetTitle || (tab && !/^\d+$/.test(tab) ? tab : undefined),
    target_url: args.target_url || args.targetUrl,
    timeout_ms: args.timeout_ms,
  };
}

function healthAlertFor(result, run) {
  const state = String(result?.state || "unknown");
  if (["healthy", "generating"].includes(state)) return null;
  if (state === "generation_timeout") return "网页模型持续生成超时，可能卡死或停止响应";
  if (state === "selector_degraded") return "网页模型页面选择器降级，页面可能已更新";
  if (state === "composer_missing") return "网页编辑器或发送控件不可用";
  if (state === "page_unresponsive") return "网页标签页无响应";
  if (state === "login_required") return "网页端登录状态丢失";
  if (state === "browser_unreachable") return "浏览器调试端点不可达";
  if (state === "provider_tab_not_found") return "没有找到绑定的网页模型标签页";
  if (state === "target_selection_required") return "网页模型标签页不唯一，需要重新确认目标";
  if (state === "page_loading") return "网页模型页面仍在加载";
  return `网页模型健康状态异常：${state}`;
}

function persistWatchdogAlert(run, result, alert) {
  if (!alert || !run.route_id) return;
  const changed = run.last_alert?.state !== result.state || run.last_alert?.message !== alert;
  if (!changed) return;
  const entry = {
    state: result.state,
    message: alert,
    checked_at: result.checked_at || new Date().toISOString(),
  };
  run.alert_count += 1;
  run.last_alert = entry;
  const route = updateRoute(run.route_id, {
    browser_health: entry,
    last_action: "browser_watchdog_alert",
  });
  appendRouteEvent(route.route_id, {
    type: "BROWSER_HEALTH_ALERT",
    summary: alert,
    data: { state: entry.state, provider: result.provider, tab: result.tab || null },
  });
}

async function browserWatchdogScan(args = {}) {
  try {
    const result = await scanBrowser(watchdogArgs(args));
    return jsonResult(`浏览器守护检查：${result.state}`, result, !result.ok && result.state === "browser_unreachable");
  } catch (error) {
    return jsonResult(`浏览器守护检查失败：${String(error)}`, { ok: false, state: "watchdog_error" }, true);
  }
}

async function browserWatchdogStart(args = {}) {
  const name = String(args.name || args.label || "默认浏览器守护").trim().slice(0, 80) || "默认浏览器守护";
  const existing = watchdogRuns.get(name);
  if (existing?.lifecycle === "running") {
    return jsonResult(`浏览器守护已在运行：${name}`, { started: false, already_running: true, watchdog: watchdogPublicView(existing) });
  }
  const interval = Math.min(Math.max(Number(args.interval_ms) || 15000, 5000), 10 * 60 * 1000);
  const run = {
    name,
    provider: args.provider || args.brain_provider || DEFAULT_BRAIN_PROVIDER,
    port: Number(args.port || DEFAULT_PORT),
    interval_ms: interval,
    lifecycle: "starting",
    state: "starting",
    checks: 0,
    alert_count: 0,
    last_alert: null,
    started_at: new Date().toISOString(),
    last_checked_at: null,
    last_result: null,
    error: null,
    timer: null,
    in_flight: false,
    generation_started_at: null,
    generation_timeout_ms: Math.min(Math.max(Number(args.generation_timeout_ms) || 180000, 15000), 30 * 60 * 1000),
    route_id: args.route_id || args.routeId || null,
    args: watchdogArgs(args),
  };
  watchdogRuns.set(name, run);
  const tick = async () => {
    if (run.in_flight || run.lifecycle !== "running") return;
    run.in_flight = true;
    try {
      const result = await scanBrowser(run.args);
      if (result.state === "generating") {
        run.generation_started_at ||= Date.now();
        if (Date.now() - run.generation_started_at >= run.generation_timeout_ms) {
          result.state = "generation_timeout";
          result.ok = false;
          result.message = `网页模型已持续生成超过 ${Math.round(run.generation_timeout_ms / 1000)} 秒`;
          result.recovery = "不要自动重发；先检查原标签页，必要时只刷新原标签页。";
        }
      } else {
        run.generation_started_at = null;
      }
      run.checks += 1;
      run.last_checked_at = new Date().toISOString();
      run.last_result = result;
      run.state = result.state;
      run.error = null;
      persistWatchdogAlert(run, result, healthAlertFor(result, run));
    } catch (error) {
      run.checks += 1;
      run.last_checked_at = new Date().toISOString();
      run.state = "watchdog_error";
      run.error = String(error);
    } finally {
      run.in_flight = false;
    }
  };
  run.lifecycle = "running";
  await tick();
  run.timer = setInterval(tick, interval);
  return jsonResult(`浏览器守护已启动：${name}`, { started: true, watchdog: watchdogPublicView(run) });
}

function browserWatchdogStatus(args = {}) {
  const name = String(args.name || args.label || "").trim();
  const runs = name ? [...watchdogRuns.values()].filter(run => run.name === name) : [...watchdogRuns.values()];
  return jsonResult("浏览器守护状态", {
    running: runs.filter(run => run.lifecycle === "running").length,
    watchdogs: runs.map(watchdogPublicView),
  });
}

function browserWatchdogStop(args = {}) {
  const name = String(args.name || args.label || "").trim();
  if (!name) return jsonResult("请提供要停止的浏览器守护名称", { stopped: false }, true);
  const run = watchdogRuns.get(name);
  if (!run) return jsonResult(`未找到浏览器守护：${name}`, { stopped: false }, true);
  if (run.timer) clearInterval(run.timer);
  run.timer = null;
  run.lifecycle = "stopped";
  run.state = "stopped";
  run.last_checked_at = run.last_checked_at || new Date().toISOString();
  return jsonResult(`浏览器守护已停止：${name}`, { stopped: true, watchdog: watchdogPublicView(run) });
}

async function githubWorkspaceStatus(args = {}) {
  const result = await inspectGithubWorkspace({ cwd: args.cwd || process.cwd() });
  return jsonResult(result.ok ? `GitHub 工作区：${result.repository?.name || "本地仓库"}` : result.message, result, !result.ok);
}

function bridgeHostStatus(args = {}) {
  const result = hostCompatibilityStatus({ host: args.host || "generic" });
  return jsonResult(`MCP 宿主兼容性：${result.selected.display_name}`, result);
}

async function artifactWorkspaceStatus(args = {}) {
  const result = await inspectArtifactWorkspace({
    cwd: args.cwd || process.cwd(),
    max_depth: args.max_depth,
    max_files: args.max_files,
  });
  return jsonResult(result.ok ? `本地素材扫描：${result.state}` : result.message, result, !result.ok);
}

async function artifactWorkspaceRead(args = {}) {
  const result = await readArtifactContext({
    cwd: args.cwd || process.cwd(),
    files: args.files,
    max_total_chars: args.max_total_chars,
    max_file_chars: args.max_file_chars,
  });
  return jsonResult(result.ok ? `本地素材读取：${result.state}` : result.message, result, !result.ok);
}

function compactWorkspaceBinding(result) {
  if (!result?.ok) return null;
  return {
    root: result.repository?.root || null,
    name: result.repository?.name || null,
    github: Boolean(result.repository?.github),
    branch: result.branch || null,
    upstream: result.upstream || null,
    ahead: Number(result.ahead || 0),
    behind: Number(result.behind || 0),
    head: result.head || null,
    changes: Array.isArray(result.changes) ? result.changes.slice(0, 40) : [],
    bound_at: new Date().toISOString(),
  };
}

function workspacePromptState(workspace) {
  if (!workspace) return undefined;
  return JSON.stringify({
    repository: workspace.name || "local repository",
    github: Boolean(workspace.github),
    branch: workspace.branch || null,
    upstream: workspace.upstream || null,
    head: workspace.head || null,
    changes: Array.isArray(workspace.changes) ? workspace.changes : [],
  });
}

async function bindGithubWorkspace(args = {}) {
  const id = routeIdOf(args);
  const result = await inspectGithubWorkspace({ cwd: args.cwd || process.cwd() });
  if (!result.ok) return jsonResult(result.message, { bound: false, workspace: result }, true);
  const workspace = compactWorkspaceBinding(result);
  const route = updateRoute(id, {
    workspace,
    last_action: "github_workspace_bind",
  });
  appendRouteEvent(id, {
    type: "WORKSPACE_BOUND",
    summary: `workspace bound: ${workspace.name || workspace.root || "local repository"}`,
    data: { github: workspace.github, branch: workspace.branch, changes: workspace.changes.length },
  });
  return jsonResult(`已绑定 GitHub 工作区：${workspace.name || workspace.root}`, {
    bound: true,
    workspace,
    route: routeSummary(readRoute(id)),
    read_only: true,
  });
}

function routeSessionIdOf(args = {}, route = null) {
  const explicitSession = args.session_id ?? args.sessionId;
  return normalizeSessionId(explicitSession || route?.session_id || route?.route_id || DEFAULT_SESSION_ID);
}

function routeBrainSummary() {
  return {
    round: brainState.round || 0,
    status: brainState.latestReview?.status || (brainState.goal ? "running" : "idle"),
    task: brainState.latestPlan?.task || null,
    report: brainState.latestReport ? {
      status: brainState.latestReport.status || null,
      changes: brainState.latestReport.changes || [],
      tests: brainState.latestReport.tests || [],
      blockers: brainState.latestReport.blockers || [],
      evidence: brainState.latestReport.evidence || [],
    } : null,
    review: brainState.latestReview ? {
      status: brainState.latestReview.status || null,
      task: brainState.latestReview.task || null,
      reason: brainState.latestReview.reason || null,
    } : null,
  };
}

function derivedRouteStatus() {
  if (activeRoute?.status === "paused") return "paused";
  const terminal = activeRoute?.latest_review?.status || brainState.latestReview?.status || brainState.latestPlan?.status;
  if (["completed", "blocked", "repeated", "max_rounds"].includes(terminal)) return terminal;
  return brainState.goal ? "running" : "idle";
}

function syncActiveRoute(extra = {}) {
  if (!activeRoute) return;
  activeRoute = writeRoute({
    ...activeRoute,
    ...extra,
    route_id: activeRouteId,
    brain_provider: activeSession?.brain_provider || activeRoute.brain_provider || DEFAULT_BRAIN_PROVIDER,
    executor_provider: activeRoute.executor_provider || DEFAULT_EXECUTOR_PROVIDER,
    executor_model: activeRoute.executor_model || null,
    executor_profile: activeRoute.executor_profile || null,
    executor_endpoint: activeRoute.executor_endpoint || null,
    executor_agent: activeRoute.executor_agent || null,
    session_id: activeSessionId,
    target_id: activeSession?.target_id || activeTargetId || null,
    conversation_id: activeSession?.conversation?.id || selectedConversation?.id || null,
    round: brainState.round || 0,
    status: extra.status || derivedRouteStatus(),
    latest_task: brainState.latestPlan?.task || activeRoute.latest_task || null,
    latest_report: routeBrainSummary().report,
    latest_review: routeBrainSummary().review,
  });
}

function activateRoute(args = {}) {
  const id = routeIdOf(args);
  const explicitRoute = args.route_id ?? args.routeId;
  let route = readRoute(id);
  const sessionId = routeSessionIdOf(args, route);
  const session = readSession(sessionId);
  const requestedProvider = args.brain_provider ?? args.brainProvider ?? args.provider;
  const requestedExecutor = args.executor_provider ?? args.executorProvider;
  const routeMatchesSession = route.session_id === sessionId;
  const providerId = requestedProvider !== undefined
    ? brainProviderIdOf(args)
    : (!explicitRoute ? session.brain_provider : (routeMatchesSession ? route.brain_provider : session.brain_provider)) || DEFAULT_BRAIN_PROVIDER;
  const executorProviderId = requestedExecutor !== undefined
    ? executorProviderIdOf(args)
    : route.executor_provider || DEFAULT_EXECUTOR_PROVIDER;
  const executorModel = args.executor_model ?? args.executorModel ?? route.executor_model ?? null;
  const executorProfile = normalizeCodexProfile(args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? "");
  const executorEndpoint = executorEndpointOf(executorProviderId, args.executor_endpoint ?? args.executorEndpoint ?? route.executor_endpoint ?? "");
  const executorAgent = executorProviderId === "opencode"
    ? normalizeExecutorAgent(args.executor_agent ?? args.executorAgent ?? route.executor_agent ?? "")
    : "";
  executorModelOf(executorProviderId, executorModel || "");
  if (explicitRoute && (route.session_id !== sessionId
    || route.brain_provider !== providerId
    || route.executor_provider !== executorProviderId
    || route.executor_model !== executorModel
    || route.executor_profile !== (executorProfile || null)
    || route.executor_endpoint !== (executorEndpoint || null)
    || route.executor_agent !== (executorAgent || null))) {
    route = writeRoute({
      ...route,
      session_id: sessionId,
      brain_provider: providerId,
      executor_provider: executorProviderId,
      executor_model: executorModel,
      executor_profile: executorProfile || null,
      executor_endpoint: executorEndpoint || null,
      executor_agent: executorAgent || null,
    });
  }
  activeRouteId = id;
  activeRoute = route;
  activateSession({ ...args, session_id: sessionId, brain_provider: providerId });
  syncActiveRoute();
  return activeRoute;
}

function ensureActiveRoute(args = {}) {
  const id = routeIdOf(args);
  if (!activeRoute || activeRouteId !== id) return activateRoute(args);
  return activeRoute;
}

function routeCreate(args = {}) {
  const rawId = args.route_id ?? args.routeId;
  if (!String(rawId || "").trim()) return jsonResult("route_id is required when creating a route", { created: false }, true);
  let id;
  try { id = normalizeRouteId(rawId); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  try {
    const existing = readRoute(id, { create: false });
    return jsonResult(`route already exists: ${id}`, { created: false, route: routeSummary(existing) }, true);
  } catch (error) {
    if (error?.code !== "ENOENT") return jsonResult(String(error), { created: false }, true);
  }
  const sessionId = routeSessionIdOf(args, { route_id: id });
  const session = readSession(sessionId);
  let brainProvider;
  try { brainProvider = brainProviderIdOf(args, session.brain_provider); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  let executorProvider;
  const executorModel = args.executor_model ?? args.executorModel ?? null;
  let executorProfile;
  try { executorProvider = executorProviderIdOf(args); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  try { executorModelOf(executorProvider, executorModel || ""); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  try { executorProfile = normalizeCodexProfile(args.executor_profile ?? args.executorProfile ?? ""); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  let executorEndpoint;
  let executorAgent;
  try { executorEndpoint = executorEndpointOf(executorProvider, args.executor_endpoint ?? args.executorEndpoint ?? ""); }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  try { executorAgent = executorProvider === "opencode" ? normalizeExecutorAgent(args.executor_agent ?? args.executorAgent ?? "") : ""; }
  catch (error) { return jsonResult(String(error), { created: false }, true); }
  const hostContext = hostCodexContextOf(args);
  const explicitCodexThreadId = String(args.codex_thread_id ?? args.codexThreadId ?? "").trim() || null;
  const codexBinding = hostContext?.thread_id && explicitCodexThreadId && explicitCodexThreadId !== hostContext.thread_id
    ? {
      state: "external_thread",
      source: "external_codex_thread",
      thread_id: explicitCodexThreadId,
      title: null,
      verified: false,
      bound_at: new Date().toISOString(),
    }
    : hostContext?.thread_id ? {
      state: "bound",
      source: "current_codex_conversation",
      thread_id: hostContext.thread_id,
      title: hostContext.title || null,
      verified: true,
      bound_at: new Date().toISOString(),
    } : null;
  const route = newRouteRecord(id, {
    name: args.name,
    brain_provider: brainProvider,
    executor_provider: executorProvider,
    executor_model: executorModel,
    executor_profile: executorProfile || null,
    executor_endpoint: executorEndpoint || null,
    executor_agent: executorAgent || null,
    codex_thread_id: explicitCodexThreadId || hostContext?.thread_id,
    codex_binding: codexBinding,
    session_id: sessionId,
    target_id: session.target_id,
    conversation_id: session.conversation?.id,
  });
  writeRoute(route);
  return jsonResult(`route created: ${id}`, { created: true, route: routeSummary(route) });
}

function routeList() {
  return jsonResult("stored control-plane routes", {
    active_route_id: activeRouteId,
    routes: listRoutes().map(routeSummary),
  });
}

function routeStatus(args = {}) {
  const id = routeIdOf(args);
  const route = readRoute(id);
  let session = null;
  try { session = readSession(route.session_id, false); } catch {}
  return jsonResult(`route status: ${id}`, {
    route: routeSummary(route),
    session: session ? sessionSummary(session) : null,
    queue_runtime: routeQueueState(id),
    events: (route.events || []).slice(-20),
  });
}

function routeBind(args = {}) {
  const id = routeIdOf(args);
  let route;
  try { route = readRoute(id, { create: false }); }
  catch (error) { return jsonResult(`route does not exist: ${id}`, { bound: false }, true); }
  const sessionId = args.session_id || args.sessionId || route.session_id;
  const session = readSession(sessionId);
  const requestedProvider = args.brain_provider ?? args.brainProvider ?? args.provider;
  const requestedExecutor = args.executor_provider ?? args.executorProvider;
  let brainProvider;
  try { brainProvider = requestedProvider !== undefined
    ? brainProviderIdOf(args)
    : ((args.session_id || args.sessionId) ? session.brain_provider : route.brain_provider); }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  let executorProvider;
  const executorModel = args.executor_model ?? args.executorModel ?? route.executor_model ?? null;
  let executorProfile;
  try { executorProvider = requestedExecutor !== undefined
    ? executorProviderIdOf(args)
    : (args.session_id || args.sessionId ? route.executor_provider || DEFAULT_EXECUTOR_PROVIDER : route.executor_provider || DEFAULT_EXECUTOR_PROVIDER); }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  try { executorModelOf(executorProvider, executorModel || ""); }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  try { executorProfile = normalizeCodexProfile(args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? ""); }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  let executorEndpoint;
  let executorAgent;
  try { executorEndpoint = executorEndpointOf(executorProvider, args.executor_endpoint ?? args.executorEndpoint ?? route.executor_endpoint ?? ""); }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  try { executorAgent = executorProvider === "opencode"
    ? normalizeExecutorAgent(args.executor_agent ?? args.executorAgent ?? route.executor_agent ?? "")
    : ""; }
  catch (error) { return jsonResult(String(error), { bound: false }, true); }
  route = writeRoute({
    ...route,
    name: args.name || route.name,
    brain_provider: brainProvider,
    executor_provider: executorProvider,
    executor_model: executorModel,
    executor_profile: executorProfile || null,
    executor_endpoint: executorEndpoint || null,
    executor_agent: executorAgent || null,
    codex_thread_id: args.codex_thread_id ?? args.codexThreadId ?? route.codex_thread_id,
    session_id: session.session_id,
    target_id: args.target_id ?? args.targetId ?? session.target_id ?? route.target_id,
    conversation_id: args.conversation_id ?? args.conversationId ?? session.conversation?.id ?? route.conversation_id,
  });
  route = appendRouteEvent(id, { type: "ROUTE_BOUND", summary: `bound route to session ${session.session_id}` });
  return jsonResult(`route bound: ${id}`, { bound: true, route: routeSummary(route) });
}

function routePause(args = {}) {
  const id = routeIdOf(args);
  let route = updateRoute(id, { status: "paused", last_action: "route_pause" });
  route = appendRouteEvent(id, { type: "PAUSED", summary: args.reason || "route paused" });
  return jsonResult(`route paused: ${id}`, { paused: true, route: routeSummary(route) });
}

function routeResume(args = {}) {
  const id = routeIdOf(args);
  let route = updateRoute(id, { status: "idle", last_action: "route_resume" });
  route = appendRouteEvent(id, { type: "RESUMED", summary: args.reason || "route resumed" });
  return jsonResult(`route resumed: ${id}`, { resumed: true, route: routeSummary(route) });
}

function routeEvent(args = {}) {
  const id = routeIdOf(args);
  const message = compileProtocolMessage(args.type || args.event_type || "EVENT", {
    summary: args.summary,
    message: args.message,
    data: args.data,
  });
  const event = enqueueRouteEvent(id, message);
  return jsonResult(`route event queued: ${id}`, {
    queued: true,
    route: routeSummary(event),
    event: event.queue?.last_event || null,
  });
}

function codexAdapterForRoute(routeId, executorProviderId = undefined, executorModel = "", executorProfile = "", executorEndpoint = "", executorAgent = "") {
  const id = normalizeRouteId(routeId);
  const route = readRoute(id);
  const provider = getExecutorProvider(executorProviderId || route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
  const model = executorModelOf(provider, executorModel || route.executor_model);
  const profile = executorProfileFor({ executor_profile: executorProfile || route.executor_profile }, provider, model);
  const endpoint = executorEndpointOf(provider, executorEndpoint || route.executor_endpoint || "");
  const agent = provider.kind === "opencode"
    ? normalizeExecutorAgent(executorAgent || route.executor_agent || "")
    : "";
  const adapterKey = `${provider.id}:${model || "(config)"}:${profile || "(config)"}:${endpoint || "(local)"}:${agent || "(default)"}`;
  let adapter = codexAdapters.get(id);
  if (adapter && adapter.executor_key !== adapterKey) {
    const state = adapter.status().state;
    if (["disconnected", "closed", "unavailable"].includes(state)) {
      adapter.close();
      codexAdapters.delete(id);
      adapter = null;
    } else {
      const error = new Error(`executor provider/model is already active for route ${id}; use a new route to switch from ${adapter.executor_key} to ${adapterKey}`);
      error.code = "EXECUTOR_SWITCH_REQUIRES_NEW_ROUTE";
      throw error;
    }
  }
  if (!adapter) {
    if (provider.kind === "opencode") {
      adapter = createOpenCodeAdapter({
        endpoint,
        cwd: route.workspace?.root || process.cwd(),
        model,
        agent,
      });
    } else {
      adapter = createCodexAdapter({
        cwd: process.cwd(),
        args: codexLaunchArgs(provider, model, profile),
        onNotification: message => {
          if (message.method === "turn/completed") {
            appendRouteEvent(id, {
              type: "CODEX_TURN_COMPLETED",
              summary: `Codex turn completed: ${message.params?.turn?.status || "unknown"}`,
            });
          }
        },
      });
    }
    adapter.executor_key = adapterKey;
    adapter.executor_provider = provider.id;
    adapter.executor_model = model;
    adapter.executor_profile = profile || null;
    adapter.executor_endpoint = endpoint || null;
    adapter.executor_agent = agent || null;
    codexAdapters.set(id, adapter);
  }
  return adapter;
}

function codexAdapterStatus(args = {}) {
  const id = routeIdOf(args);
  const route = readRoute(id);
  const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
  const model = executorModelOf(provider, args.executor_model ?? args.executorModel ?? route.executor_model);
  const profile = executorProfileFor(args, provider, model);
  const endpoint = executorEndpointFor(args, provider);
  const agent = executorAgentFor(args, provider);
  return jsonResult(`Codex Adapter status: ${id}`, {
    adapter: codexAdapterForRoute(id, provider.id, model, profile, endpoint, agent).status(),
    executor_provider: provider.id,
    executor_model: model,
    executor_profile: profile || null,
    executor_endpoint: endpoint || null,
    executor_agent: agent || null,
    route: routeSummary(route),
  });
}

async function codexThreadStart(args = {}) {
  let route = activateRoute(args);
  try {
    const hostContext = hostCodexContextOf(args);
    const explicitlyRequestedThread = args.codex_thread_id || args.codexThreadId || null;
    if (route.codex_binding?.source === "external_codex_thread" && !explicitlyRequestedThread) {
      const error = new Error("该路由包含另一个 Codex 对话；必须通过显式 Codex Adapter 调用，不能把它当作当前 Codex Worker 执行");
      error.code = "CODEX_EXTERNAL_THREAD_REQUIRES_EXPLICIT_ADAPTER";
      throw error;
    }
    if (hostContext?.thread_id && route.codex_binding?.thread_id && route.codex_binding.thread_id !== hostContext.thread_id && route.codex_binding?.source !== "external_codex_thread") {
      const error = new Error("当前 Codex 对话与该路由已绑定的 Worker 不一致；未切换执行线程");
      error.code = "CODEX_THREAD_BINDING_MISMATCH";
      throw error;
    }
    const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelFor({ ...args, executor_model: args.executor_model ?? args.executorModel ?? args.model ?? route.executor_model }, provider);
    const profile = executorProfileFor(args, provider, model);
    const endpoint = executorEndpointFor(args, provider);
    const agent = executorAgentFor(args, provider);
    route = updateRoute(route.route_id, {
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? null,
      executor_endpoint: endpoint || null,
      executor_agent: agent || null,
    });
    const adapter = codexAdapterForRoute(route.route_id, provider.id, model, profile, endpoint, agent);
    const requestedThreadId = explicitlyRequestedThread || route.codex_thread_id || hostContext?.thread_id || null;
    const bindingSource = hostContext?.thread_id && requestedThreadId === hostContext.thread_id
      ? "current_codex_conversation"
      : route.codex_binding?.source || "managed_worker";
    const result = await adapter.startThread({
      thread_id: requestedThreadId,
      cwd: args.cwd || process.cwd(),
      model,
      baseInstructions: args.base_instructions,
      approvalPolicy: args.approval_policy,
      title: args.title || "Codex Bridge task",
    });
    const updated = updateRoute(route.route_id, {
      codex_thread_id: result.thread_id,
      codex_binding: {
        state: "bound",
        source: bindingSource,
        thread_id: result.thread_id,
        title: hostContext?.title || route.codex_binding?.title || null,
        verified: bindingSource === "current_codex_conversation",
        bound_at: new Date().toISOString(),
      },
      status: "worker_ready",
      last_action: "codex_thread_start",
    });
    if (activeRouteId === route.route_id) activeRoute = updated;
    appendRouteEvent(route.route_id, {
      type: "CODEX_THREAD_READY",
      summary: `Codex thread ready: ${result.thread_id || "unknown"}`,
    });
    return jsonResult(`Codex worker ready: ${route.route_id}`, {
      started: true,
      thread_id: result.thread_id,
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: profile || null,
      executor_endpoint: endpoint || null,
      executor_agent: agent || null,
      codex_binding: codexBindingView(updated),
      route: routeSummary(updated),
      adapter: adapter.status(),
    });
  } catch (error) {
    return jsonResult(String(error), { started: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
  }
}

async function syncCodexNativeGoal({ routeId = activeRouteId, objective, status = "active", tokenBudget = null } = {}) {
  const id = normalizeRouteId(routeId);
  const route = readRoute(id);
  const goal = String(objective || "").trim();
  if (!goal) {
    return { synced: false, state: "pending", code: "CODEX_GOAL_EMPTY", reason: "native Codex Goal objective is empty" };
  }
  if (!route.codex_thread_id) {
    const pending = {
      synced: false,
      state: "pending",
      code: "CODEX_WORKER_NOT_STARTED",
      reason: "Codex worker has not started; native Goal will be retried when the worker starts",
    };
    const updated = updateRoute(id, { native_goal: pending });
    if (activeRouteId === id) activeRoute = updated;
    return pending;
  }
  if (route.codex_binding?.source === "external_codex_thread") {
    const pending = {
      synced: false,
      state: "blocked",
      code: "CODEX_EXTERNAL_THREAD_NOT_BOUND",
      reason: "native Codex Goal is not synchronized to an explicitly supplied external thread",
      thread_id: route.codex_thread_id,
    };
    const updated = updateRoute(id, { native_goal: pending, status: "paused", last_action: "codex_thread_goal_blocked" });
    appendRouteEvent(id, { type: "CODEX_GOAL_SYNC_BLOCKED", summary: "native Goal blocked for an external Codex thread" });
    if (activeRouteId === id) activeRoute = updated;
    return { ...pending, route: routeSummary(updated) };
  }
  try {
    const provider = getExecutorProvider(route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelOf(provider, route.executor_model || "");
    const profile = codexProfileOf(provider, route.executor_profile || "", model);
    const endpoint = executorEndpointOf(provider, route.executor_endpoint || "");
    const agent = provider.kind === "opencode" ? normalizeExecutorAgent(route.executor_agent || "") : "";
    const adapter = codexAdapterForRoute(id, provider.id, model, profile, endpoint, agent);
    const result = await adapter.setThreadGoal({
      thread_id: route.codex_thread_id,
      objective: goal,
      status,
      tokenBudget,
    });
    const native = result?.goal || {};
    const method = result?.method || (result?.local_only ? "bridge_goal" : "thread/goal/set");
    const synced = {
      synced: true,
      state: result?.local_only ? "bridge_goal_only" : "synced",
      method,
      thread_id: route.codex_thread_id,
      objective: native.objective || goal,
      status: native.status || status,
      token_budget: native.tokenBudget ?? tokenBudget ?? null,
      local_only: Boolean(result?.local_only),
      executor_provider: provider.id,
      synced_at: new Date().toISOString(),
    };
    const updated = updateRoute(id, { native_goal: synced, last_action: "codex_thread_goal_set" });
    appendRouteEvent(id, {
      type: "CODEX_GOAL_SYNCED",
      summary: `${provider.id} goal state recorded: ${route.codex_thread_id}`,
      data: { method: synced.method, status: synced.status, local_only: synced.local_only },
    });
    if (activeRouteId === id) activeRoute = readRoute(id);
    return { ...synced, route: routeSummary(updated) };
  } catch (error) {
    const failed = {
      synced: false,
      state: "pending",
      code: error.code || "CODEX_GOAL_SYNC_FAILED",
      reason: String(error),
      thread_id: route.codex_thread_id,
      method: route.executor_provider === "opencode" ? "bridge_goal" : "thread/goal/set",
    };
    const updated = updateRoute(id, { native_goal: failed, last_action: "codex_thread_goal_sync_failed" });
    appendRouteEvent(id, {
      type: "CODEX_GOAL_SYNC_FAILED",
      summary: `Codex native Goal sync failed: ${route.codex_thread_id}`,
      data: { code: failed.code, reason: failed.reason },
    });
    if (activeRouteId === id) activeRoute = readRoute(id);
    return { ...failed, route: routeSummary(updated) };
  }
}

async function codexThreadTurn(args = {}) {
  let route = activateRoute(args);
  if (route.codex_binding?.source === "external_codex_thread" && !String(args.codex_thread_id || args.codexThreadId || "").trim()) {
    return jsonResult("该路由绑定的是其他 Codex 对话；未执行隐式跨会话发送，请显式提供 codex_thread_id", {
      sent: false,
      route_id: route.route_id,
      code: "CODEX_EXTERNAL_THREAD_REQUIRES_EXPLICIT_ADAPTER",
    }, true);
  }
  const threadId = args.codex_thread_id || route.codex_thread_id;
  if (!threadId) return jsonResult("codex_thread_id is required; call codex_thread_start first", { sent: false }, true);
  try {
    const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelFor({ ...args, executor_model: args.executor_model ?? args.executorModel ?? args.model ?? route.executor_model }, provider);
    const profile = executorProfileFor(args, provider, model);
    const endpoint = executorEndpointFor(args, provider);
    const agent = executorAgentFor(args, provider);
    route = updateRoute(route.route_id, {
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? null,
      executor_endpoint: endpoint || null,
      executor_agent: agent || null,
    });
    const result = await codexAdapterForRoute(route.route_id, provider.id, model, profile, endpoint, agent).sendTask({
      thread_id: threadId,
      text: args.text || args.task || args.prompt,
      input: args.input,
      timeoutMs: args.timeout_ms,
      cwd: args.cwd,
      model,
      effort: args.effort,
      agent,
    });
    const updated = updateRoute(route.route_id, {
      codex_thread_id: threadId,
      status: result.completed ? "worker_ready" : "worker_running",
      last_action: "codex_thread_turn",
      latest_report: result.text ? { source: "codex", text: result.text } : route.latest_report,
    });
    return jsonResult(`Codex worker turn completed: ${route.route_id}`, {
      sent: true,
      completed: result.completed,
      thread_id: threadId,
      turn_id: result.turn_id || result.turn?.id || null,
      text: result.text || "",
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: profile || null,
      executor_endpoint: endpoint || null,
      executor_agent: agent || null,
      route: routeSummary(updated),
    });
  } catch (error) {
    return jsonResult(String(error), { sent: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
  }
}

async function codexThreadRead(args = {}) {
  const route = activateRoute(args);
  const threadId = args.codex_thread_id || route.codex_thread_id;
  if (!threadId) return jsonResult("codex_thread_id is required; call codex_thread_start first", { read: false }, true);
  try {
    const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelFor({ ...args, executor_model: args.executor_model ?? args.executorModel ?? args.model ?? route.executor_model }, provider);
    const profile = executorProfileFor(args, provider, model);
    const endpoint = executorEndpointFor(args, provider);
    const agent = executorAgentFor(args, provider);
    const result = await codexAdapterForRoute(route.route_id, provider.id, model, profile, endpoint, agent).readThread(threadId);
    return jsonResult(`Codex/OpenCode session read: ${threadId}`, { read: true, thread_id: threadId, executor_provider: provider.id, executor_model: model, executor_profile: profile || null, executor_endpoint: endpoint || null, executor_agent: agent || null, result });
  } catch (error) {
    return jsonResult(String(error), { read: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
  }
}

function collectCodexSourceText(value, chunks = [], seen = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 10 || chunks.join("\n").length >= 24000) return chunks;
  if (typeof value === "string") {
    if (value.trim()) chunks.push(value.trim());
    return chunks;
  }
  if (typeof value !== "object" || seen.has(value)) return chunks;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCodexSourceText(item, chunks, seen, depth + 1);
    return chunks;
  }
  for (const key of ["title", "summary", "message", "text", "content", "body", "output"]) {
    if (key in value) collectCodexSourceText(value[key], chunks, seen, depth + 1);
  }
  return chunks;
}

async function codexSourceThreadRead(args = {}) {
  const threadUrl = String(args.thread_url || args.threadUrl || "").trim();
  const threadId = codexThreadIdFromUrl(threadUrl);
  if (!threadId) {
    return jsonResult("thread_url must be an explicit codex://threads/<thread-id> URL", { read: false, code: "CODEX_SOURCE_URL_INVALID" }, true);
  }
  const route = activateRoute(args);
  let adapter;
  try {
    const provider = getExecutorProvider("chatgpt_luna");
    const model = executorModelOf(provider, provider.default_model);
    const profile = codexProfileOf(provider, "", model);
    adapter = createCodexAdapter({
      cwd: route.workspace?.root || process.cwd(),
      args: codexLaunchArgs(provider, model, profile),
    });
    const result = await adapter.readThread(threadId);
    const maxChars = Math.min(24000, Math.max(1000, Number(args.max_chars) || 12000));
    const sourceText = clip(collectCodexSourceText(result).join("\n\n"), maxChars);
    return jsonResult(`已只读读取指定 Codex 对话：${threadId}`, {
      read: true,
      source: "explicit_codex_thread",
      thread_url: threadUrl,
      thread_id: threadId,
      text: sourceText,
      truncated: sourceText.endsWith("...[truncated]"),
      note: "这是其他 Codex 对话的只读内容；不会把它绑定为当前 Codex Worker，也不会自动执行或转发。",
    });
  } catch (error) {
    return jsonResult(String(error), { read: false, thread_url: threadUrl, code: error.code || "CODEX_SOURCE_READ_FAILED" }, true);
  } finally {
    adapter?.close?.();
  }
}

function claimedTargetIds(excludeSessionId = "") {
  const claimed = new Set();
  for (const session of listStoredSessions()) {
    if (session.session_id !== excludeSessionId && session.target_id) claimed.add(session.target_id);
  }
  return claimed;
}

function jsonResult(text, structuredContent = undefined, isError = false) {
  const result = { content: [{ type: "text", text }], isError };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function nativeUiResult(text, structuredContent = undefined, isError = false) {
  const result = jsonResult(text, structuredContent, isError);
  result._meta = { ui: { resourceUri: MCP_UI_RESOURCE_URI } };
  return result;
}

function nativeUiResource() {
  return {
    uri: MCP_UI_RESOURCE_URI,
    name: "Codex Web LLM Bridge control panel",
    title: "Codex ↔ Web LLM Bridge",
    description: "Native in-conversation status display for a visible ChatGPT Web or DeepSeek Web connection.",
    mimeType: MCP_UI_RESOURCE_MIME,
  };
}

function readNativeUiHtml() {
  return fs.readFileSync(MCP_UI_RESOURCE_PATH, "utf8");
}

const clip = brainClip;
const stringList = brainStringList;
const maxRoundsOf = value => stopMaxRoundsOf(value, DEFAULT_MAX_ROUNDS);
const newBrainState = () => createBrainState(DEFAULT_MAX_ROUNDS);
const recordTask = task => recordBrainTask(brainState, task);
const recordReport = report => recordBrainReport(brainState, report);
const normalizeReport = args => normalizeBrainReport(args, brainState.round);

function brainStateView() {
  const executorProvider = activeRoute?.executor_provider || DEFAULT_EXECUTOR_PROVIDER;
  return {
    route_id: activeRouteId,
    session_id: activeSessionId,
    brain_provider: activeSession?.brain_provider || activeRoute?.brain_provider || DEFAULT_BRAIN_PROVIDER,
    executor_provider: executorProvider,
    executor_model: activeRoute?.executor_model || executorModelOf(executorProvider),
    executor_profile: activeRoute?.executor_profile || null,
    codex_thread_id: activeRoute?.codex_thread_id || null,
    mode: brainState.mode,
    goal: brainState.goal,
    task_ir: brainState.taskIR,
    constraints: brainState.constraints,
    round: brainState.round,
    max_rounds: brainState.maxRounds,
    latest_plan: brainState.latestPlan,
    latest_report: brainState.latestReport,
    completion_proof: brainState.latestReport ? completionProof(brainState.latestReport) : null,
    latest_review: brainState.latestReview,
    conversation: selectedConversation,
    browser_target_id: activeSession?.target_id || null,
    started_at: brainState.startedAt,
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
  };
}

function resultText(result) {
  return result?.content?.find(item => item.type === "text")?.text || "";
}

function durableWebDelivery(deliveryId, fields = {}) {
  return writeWebDelivery(deliveryId, {
    route_id: activeRouteId,
    ...fields,
  });
}

async function brainPlan(args = {}) {
  activateRoute(args);
  const goal = clip(args.goal);
  if (!goal.trim()) return jsonResult("goal is required", { planned: false }, true);
  brainState = newBrainState();
  brainState.goal = goal;
  brainState.constraints = stringList(args.constraints);
  brainState.continuous = args.continuous === true || args.mode === "continuous";
  brainState.maxRounds = brainState.continuous ? null : maxRoundsOf(args.max_rounds);
  brainState.startedAt = new Date().toISOString();
  brainState.taskIR = taskIRFromArgs({ ...args, goal, constraints: brainState.constraints });
  const prompt = planPrompt(goal, brainState.constraints, JSON.stringify(brainState.taskIR, null, 2));
  const result = await askBrain({ ...args, port: args.port, timeout_ms: args.timeout_ms, prompt });
  if (result.isError) return result;
  const rawReply = resultText(result);
  brainState.lastWebReply = rawReply;
  const decision = decisionFromReply(rawReply);
  const plan = { round: 0, ...decision };
  brainState.latestPlan = plan;
  recordTask(plan);
  persistActiveSession();
  return jsonResult(`brain plan ready: ${plan.task}`, {
    planned: true,
    mode: brainState.mode,
    round: brainState.round,
    max_rounds: brainState.maxRounds,
    status: plan.status,
    task: plan.task,
    constraints: plan.constraints,
    acceptance: plan.acceptance,
    evidence: plan.evidence,
    reason: plan.reason,
    raw_reply: rawReply,
  });
}

async function executorReport(args = {}) {
  activateRoute(args);
  if (!brainState.goal) return jsonResult("call brain_plan before executor_report", { reported: false }, true);
  const report = normalizeReport(args);
  if (!report.report.trim() || report.report === "{}") {
    return jsonResult("report, result, summary, or execution fields are required", { reported: false }, true);
  }
  brainState.latestReport = report;
  recordReport(report);
  const result = await askBrain({
    ...args,
    port: args.port,
    timeout_ms: args.timeout_ms,
    prompt: reportPrompt(brainState.goal, brainState.round, JSON.stringify(report, null, 2)),
  });
  if (result.isError) return result;
  const acknowledgement = resultText(result);
  brainState.lastWebReply = acknowledgement;
  persistActiveSession();
  return jsonResult(`executor report sent to ${brainProviderOf(args).display_name}`, {
    reported: true,
    round: report.round,
    report,
    web_ack: acknowledgement,
  });
}

async function brainReview(args = {}) {
  activateRoute(args);
  if (!brainState.goal) return jsonResult("call brain_plan before brain_review", { reviewed: false }, true);
  if (args.report || args.result || args.summary || args.changes || args.tests || args.blockers || args.evidence) {
    brainState.latestReport = normalizeReport(args);
    recordReport(brainState.latestReport);
  }
  if (!brainState.latestReport) return jsonResult("executor report is required before brain_review", { reviewed: false }, true);
  const result = await askBrain({
    ...args,
    port: args.port,
    timeout_ms: args.timeout_ms,
    prompt: reviewPrompt({
      goal: brainState.goal,
      latestPlan: brainState.latestPlan,
      taskIR: brainState.taskIR,
      latestReport: brainState.latestReport,
      latestReview: brainState.latestReview,
    }),
  });
  if (result.isError) return result;
  const rawReply = resultText(result);
  brainState.lastWebReply = rawReply;
  const decision = decisionFromReply(rawReply);
  const reportKey = fingerprint(brainState.latestReport);
  const repeatResult = detectRepeated({
    decision,
    decisionHistory: brainState.seenDecisionFingerprints,
    reportFingerprint: reportKey,
    reportHistory: brainState.seenReportFingerprints,
  });
  const repeated = decision.status === "continue" && repeatResult.repeated;
  if (!brainState.seenDecisionFingerprints.includes(repeatResult.decision_key)) {
    brainState.seenDecisionFingerprints.push(repeatResult.decision_key);
  }
  if (repeated) {
    decision.status = "repeated";
    decision.reason = decision.reason || "the same plan/report decision repeated without new evidence";
  }
  const evidenceResult = enforceEvidenceFirst(decision, brainState.latestReport);
  const finalDecision = evidenceResult.decision;
  const proof = evidenceResult.proof;
  brainState.latestReview = { round: brainState.round, ...finalDecision, repeated_detected: repeated, completion_proof: proof };
  persistActiveSession();
  return jsonResult(`brain review: ${brainState.latestReview.status}`, {
    reviewed: true,
    round: brainState.round,
    status: brainState.latestReview.status,
    next_task: brainState.latestReview.task,
    constraints: brainState.latestReview.constraints,
    acceptance: brainState.latestReview.acceptance,
    evidence: brainState.latestReview.evidence,
    reason: brainState.latestReview.reason,
    repeated_detected: repeated,
    completion_proof: proof,
    raw_reply: rawReply,
  });
}

async function continueTask(args = {}) {
  activateRoute(args);
  if (!brainState.goal) return jsonResult("call brain_plan before continue_task", { continued: false }, true);
  if (args.max_rounds !== undefined) brainState.maxRounds = maxRoundsOf(args.max_rounds);
  if (args.executor_report || args.result || args.summary || args.changes || args.tests || args.blockers || args.evidence) {
    const reportResult = await executorReport(args);
    if (reportResult.isError) return reportResult;
  }
  const reviewResult = brainState.latestReview && !args.review
    ? jsonResult("using latest brain review", brainState.latestReview)
    : await brainReview(args);
  if (reviewResult.isError) return reviewResult;
  const review = brainState.latestReview;
  if (["completed", "blocked", "repeated"].includes(review.status)) {
    return jsonResult(`task stopped: ${review.status}`, {
      continued: false,
      stopped: true,
      status: review.status,
      round: brainState.round,
      reason: review.reason,
      state: brainStateView(),
    });
  }
  if (roundLimitReached(brainState.round, brainState.maxRounds)) {
    brainState.latestReview.status = "max_rounds";
    persistActiveSession();
    return jsonResult(`task stopped: max rounds ${brainState.maxRounds}`, {
      continued: false,
      stopped: true,
      status: "max_rounds",
      round: brainState.round,
      max_rounds: brainState.maxRounds,
      state: brainStateView(),
    });
  }
  brainState.round += 1;
  const nextPlan = { round: brainState.round, status: "continue", task: review.task, acceptance: review.acceptance, constraints: review.constraints, evidence: review.evidence, reason: review.reason };
  brainState.latestPlan = nextPlan;
  recordTask(nextPlan);
  persistActiveSession();
  return jsonResult(`continue task round ${brainState.round}: ${nextPlan.task}`, {
    continued: true,
    stopped: false,
    status: "continue",
    round: brainState.round,
    max_rounds: brainState.maxRounds,
    task: nextPlan.task,
    constraints: nextPlan.constraints,
    acceptance: nextPlan.acceptance,
    evidence: nextPlan.evidence,
    state: brainStateView(),
  });
}

async function runRound(args = {}) {
  activateRoute(args);
  const result = await runtimeRunner.runRound(args);
  return jsonResult(
    result.stopped ? `runtime stopped: ${result.status}` : `runtime round ${result.round} ready`,
    { ...result, state: brainStateView() },
  );
}

async function runUntilStop(args = {}) {
  activateRoute(args);
  const result = await runtimeRunner.runUntilStop(args);
  return jsonResult(
    result.stopped ? `runtime stopped: ${result.status}` : "runtime completed",
    { ...result, state: brainStateView() },
  );
}

function brainStatus(args = {}) {
  activateRoute(args);
  return jsonResult("brain-hand state", brainStateView());
}

function brainReset(args = {}) {
  activateRoute(args);
  brainState = newBrainState();
  persistActiveSession();
  return jsonResult("brain-hand state reset", brainStateView());
}

function portOf(args = {}) {
  const value = Number(args.port ?? process.env.CHATGPT_BRIDGE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return value;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

async function listTargets(port) {
  return getJson(`http://127.0.0.1:${port}/json/list`);
}

function closeSocket() {
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
  target = null;
  activeTargetId = null;
  for (const reject of pending.values()) reject(new Error("browser connection closed"));
  pending.clear();
}

async function connectToTarget(nextTarget) {
  if (!nextTarget?.webSocketDebuggerUrl) throw new Error("target has no DevTools websocket");
  closeSocket();
  target = nextTarget;
  activeTargetId = nextTarget.id || null;
  socket = new WebSocket(nextTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out connecting to browser")), 8000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("could not connect to browser DevTools"));
    }, { once: true });
  });
  socket.addEventListener("message", event => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "DevTools command failed"));
        else resolve(message.result);
      }
    } catch {}
  });
  socket.addEventListener("close", closeSocket, { once: true });
  await cdpRaw("Runtime.enable", {});
  await cdpRaw("Page.enable", {});
}

function cdpRaw(method, params) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("browser is not connected"));
  }
  const id = ++commandId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }
    }, 30000);
  });
}

async function evaluate(expression) {
  const result = await cdpRaw("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "unknown page error";
    throw new Error(`page evaluation failed: ${detail}`);
  }
  return result?.result?.value;
}

async function createBrainTarget(port, provider = brainProviderOf(), session = activeSession) {
  const key = `${port}:${provider.id}:${session?.session_id || activeSessionId}`;
  const pending = pendingBrainTargetCreation.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${provider.start_url}`, { method: "PUT" });
    if (!response.ok) throw new Error(`could not create a browser tab: ${response.status} ${response.statusText}`);
    const created = await response.json();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const targets = await listTargets(port);
        const ready = created?.id ? targets.find(item => item.id === created.id) : null;
        if (ready?.webSocketDebuggerUrl) return ready;
        if (created?.webSocketDebuggerUrl && attempt >= 2) return created;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return created;
  })().finally(() => pendingBrainTargetCreation.delete(key));
  pendingBrainTargetCreation.set(key, operation);
  return operation;
}

async function findBrainTarget(port, session = activeSession, provider = brainProviderOf(), selection = {}) {
  const targets = await listTargets(port);
  const pages = targets.filter(item => item.type === "page");
  const requestedTargetId = String(selection.target_id || selection.targetId || "").trim();
  const requestedTargetTitle = String(selection.target_title || selection.targetTitle || "").trim();
  const requestedTargetUrl = String(selection.target_url || selection.targetUrl || "").trim();
  const selectorCount = [requestedTargetId, requestedTargetTitle, requestedTargetUrl].filter(Boolean).length;
  if (selectorCount > 1) {
    const error = new Error("provide only one of target_id, target_title, or target_url");
    error.code = "BROWSER_TARGET_SELECTOR_CONFLICT";
    throw error;
  }
  if (selectorCount) {
    const matches = requestedTargetId
      ? pages.filter(item => item.id === requestedTargetId)
      : requestedTargetUrl
        ? pages.filter(item => item.url === requestedTargetUrl)
        : pages.filter(item => item.title === requestedTargetTitle);
    if (matches.length > 1) {
      const value = requestedTargetId || requestedTargetUrl || requestedTargetTitle;
      const kind = requestedTargetId ? "id" : requestedTargetUrl ? "URL" : "title";
      const error = new Error(`browser target ${kind} is ambiguous: ${value}`);
      error.code = "BROWSER_TARGET_AMBIGUOUS";
      throw error;
    }
    const selected = matches[0];
    if (!selected) {
      const value = requestedTargetId || requestedTargetUrl || requestedTargetTitle;
      const kind = requestedTargetId ? "ID" : requestedTargetUrl ? "URL" : "title";
      const error = new Error(`browser target ${kind} not found: ${value}`);
      error.code = "BROWSER_TARGET_NOT_FOUND";
      throw error;
    }
    if (!providerMatchesUrl(provider, selected.url)) {
      const error = new Error(`browser target is not a ${provider.display_name} page: ${selected.url || selected.title || selected.id}`);
      error.code = "BROWSER_TARGET_PROVIDER_MISMATCH";
      throw error;
    }
    return selected;
  }
  if (session?.target_id) {
    const stored = pages.find(item => item.id === session.target_id);
    if (stored && providerMatchesUrl(provider, stored.url)) return stored;
    // A session that already owns a tab must never fall through to another
    // page. The caller can explicitly recover the closed tab, but normal
    // sends and health checks must fail closed instead of switching targets.
    return null;
  }
  if (session?.conversation?.id) {
    const stored = pages.find(item => providerMatchesUrl(provider, item.url) && conversationIdFromUrl(item.url || "", provider.id) === session.conversation.id);
    if (stored) return stored;
  }
  const claimed = claimedTargetIds(session?.session_id || "");
  return pages.find(item => providerMatchesUrl(provider, item.url) && !claimed.has(item.id)) || null;
}

async function ensureConnected(port, session = activeSession, provider = brainProviderOf(), { allowCreate = !session?.target_id } = {}) {
  if (socket && socket.readyState === WebSocket.OPEN && target && session?.target_id === target.id && providerMatchesUrl(provider, target.url)) return;
  let page = await findBrainTarget(port, session, provider);
  if (!page && allowCreate) page = await createBrainTarget(port, provider, session);
  if (!page) {
    throw new Error(session?.target_id
      ? "the bound browser tab is unavailable; no new tab was opened automatically"
      : `no browser page found. Launch a browser with remote debugging on port ${port}, then open ${provider.start_url}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await connectToTarget(page);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      closeSocket();
      await new Promise(resolve => setTimeout(resolve, 350));
      try {
        const targets = await listTargets(port);
        page = (page.id && targets.find(item => item.id === page.id && providerMatchesUrl(provider, item.url))) || await findBrainTarget(port, session, provider);
      } catch {}
    }
  }
  if (lastError) throw lastError;
  if (session) {
    session.target_id = page.id || null;
    session.target_url = page.url || null;
    persistActiveSession();
  }
}

async function currentConversationData(provider = brainProviderOf()) {
  const adapter = getWebLLMAdapter(provider.id);
  const profile = adapter.profile;
  const linkSelectors = JSON.stringify(profile.conversation_link_selectors);
  const conversationPrefixes = JSON.stringify(profile.conversation_prefixes || []);
  const conversationPathPatterns = JSON.stringify(profile.conversation_path_patterns || []);
  const state = await evaluate(`(() => {
    const url = location.href;
    const selectors = ${linkSelectors};
    const prefixes = ${conversationPrefixes};
    const pathPatterns = ${conversationPathPatterns};
    const links = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    const current = links.find(anchor => anchor.href.split('?')[0] === url.split('?')[0]);
    const rawTitle = (current?.getAttribute('aria-label') || current?.innerText || document.title || '').trim();
    const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
    const isConversation = prefixes.some(prefix => location.pathname.toLowerCase().startsWith(prefix.toLowerCase()))
      || pathPatterns.some(pattern => new RegExp(pattern, 'i').test(location.pathname));
    return { title, url, is_conversation: isConversation };
  })()`);
  return { ...state, id: conversationIdFromUrl(state?.url || "", provider.id) };
}

async function visibleConversations(query = "", provider = brainProviderOf()) {
  const adapter = getWebLLMAdapter(provider.id);
  const profile = adapter.profile;
  const queryLiteral = JSON.stringify(String(query || "").trim().toLowerCase());
  const conversations = await evaluate(`(() => {
    const query = ${queryLiteral};
    const seen = new Set();
    const selectors = ${JSON.stringify(profile.conversation_link_selectors)};
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)]).map(anchor => {
      const url = anchor.href.split('?')[0];
      const rawTitle = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
      const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
      return { title, url, current: url === location.href.split('?')[0] };
    }).filter(item => item.title && !seen.has(item.url) && seen.add(item.url))
      .filter(item => !query || item.title.toLowerCase().includes(query));
  })()`);
  return conversations
    .map(item => ({ ...item, id: conversationIdFromUrl(item.url, provider.id) }))
    .filter(item => item.id);
}

async function listConversations(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  try {
    await ensureConnected(port, activeSession, provider);
    const conversations = await visibleConversations(args.query, provider);
    const current = await currentConversationData(provider);
    selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    persistActiveSession();
    return jsonResult(`found ${conversations.length} visible ${provider.display_name} conversations`, {
      conversations,
      current,
      count: conversations.length,
      brain_provider: provider.id,
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
    });
  } catch (error) {
    return jsonResult(String(error), { conversations: [], count: 0, session_id: activeSessionId }, true);
  }
}

async function selectConversation(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  if (brainState.goal && !args.force) {
    return jsonResult("an active brain-hand task exists; call brain_reset or pass force=true before switching conversations", {
      selected: false,
      active_goal: brainState.goal,
      session_id: activeSessionId,
    }, true);
  }
  try {
    await ensureConnected(port, activeSession, provider);
    let destination = safeConversationUrl(args.url || args.conversation_id || args.id, provider.id);
    let chosen = null;
    if (args.title) {
      const conversations = await visibleConversations("", provider);
      const wanted = String(args.title).trim().toLowerCase();
      const exact = conversations.filter(item => item.title.toLowerCase() === wanted);
      const partial = conversations.filter(item => item.title.toLowerCase().includes(wanted));
      const matches = exact.length ? exact : partial;
      if (matches.length !== 1) {
        return jsonResult(matches.length ? "conversation title is ambiguous" : "conversation title was not found in the visible sidebar", {
          selected: false,
          query: args.title,
          candidates: matches.slice(0, 20),
        }, true);
      }
      chosen = matches[0];
      destination = chosen.url;
    }
    if (!destination) return jsonResult(`provide title, conversation_id, id, or a ${provider.display_name} conversation URL`, { selected: false }, true);
    const safeUrl = safeConversationUrl(destination, provider.id);
    if (!safeUrl) return jsonResult(`only ${provider.display_name} conversation URLs or conversation IDs are allowed`, { selected: false }, true);
    const destinationId = conversationIdFromUrl(safeUrl, provider.id);
    const current = await currentConversationData(provider);
    if (current.url.split('?')[0] !== safeUrl) await cdpRaw("Page.navigate", { url: safeUrl });
    const deadline = Date.now() + Math.min(Math.max(Number(args.timeout_ms || 15000), 5000), 60000);
    let state = current;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      state = await currentConversationData(provider);
      if (state.id === destinationId && state.url.split('?')[0] === safeUrl) break;
    }
    if (state.id !== destinationId) return jsonResult("timed out waiting for the selected conversation to open", { selected: false, url: safeUrl }, true);
    selectedConversation = { id: state.id, title: chosen?.title || state.title, url: state.url };
    persistActiveSession();
    return jsonResult(`selected ${provider.display_name} conversation: ${selectedConversation.title || selectedConversation.id}`, {
      selected: true,
      conversation: selectedConversation,
      brain_provider: provider.id,
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
    });
  } catch (error) {
    return jsonResult(String(error), { selected: false, session_id: activeSessionId }, true);
  }
}

async function currentConversation(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  try {
    await ensureConnected(port, activeSession, provider);
    const current = await currentConversationData(provider);
    selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    persistActiveSession();
    return jsonResult(current.is_conversation ? `current ${provider.display_name} conversation: ${current.title || current.id}` : `${provider.display_name} is on the home page`, {
      current,
      brain_provider: provider.id,
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
    });
  } catch (error) {
    return jsonResult(String(error), { current: null, session_id: activeSessionId }, true);
  }
}

function browserCandidates() {
  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

function defaultProfileDir() {
  const localAppData = process.env.LOCALAPPDATA || os.homedir();
  const preferred = path.join(localAppData, "CodexBridgeEdge");
  const legacy = path.join(localAppData, "CodexChatGPTBridge", "profile");
  // Keep an existing profile so users who tried an earlier plugin build do not
  // lose their saved web login when the automatic launcher changes its name.
  return fs.existsSync(preferred) || !fs.existsSync(legacy) ? preferred : legacy;
}

function launchBrowser(args = {}) {
  const provider = brainProviderOf(args);
  const executable = browserCandidates().find(candidate => fs.existsSync(candidate));
  if (!executable) {
    return {
      launched: false,
      message: "Chrome or Edge was not found. Start one manually with remote debugging enabled.",
      command: `chrome.exe --remote-debugging-port=${portOf(args)} --user-data-dir=\\"${defaultProfileDir()}\\" ${provider.start_url}`,
    };
  }
  const port = portOf(args);
  const profileDir = path.resolve(args.profile_dir || defaultProfileDir());
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    provider.start_url,
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.once("error", () => {});
  child.unref();
  return {
    launched: true,
    automatic_profile: !args.profile_dir,
    executable,
    browser_name: /msedge(?:\.exe)?$/i.test(executable) ? "Edge" : "Chrome",
    port,
    profile_dir: profileDir,
    profile_name: path.basename(profileDir),
    url: provider.start_url,
    brain_provider: provider.id,
  };
}

async function waitForDebugEndpoint(port, timeoutMs = 8000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 8000, 1000), 20000);
  while (Date.now() < deadline) {
    try {
      const [version, targets] = await Promise.all([
        getJson(`http://127.0.0.1:${port}/json/version`),
        listTargets(port),
      ]);
      if (version?.webSocketDebuggerUrl && Array.isArray(targets)) return { version, targets };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function launchDedicatedBrowserIfNeeded(args = {}) {
  if (args.auto_launch === false) return { attempted: false, launched: false };
  if (pendingDedicatedLaunch) return pendingDedicatedLaunch;
  pendingDedicatedLaunch = (async () => {
    const profileDir = path.resolve(args.profile_dir || defaultProfileDir());
    const existing = await localEdgeProcessCandidates();
    const alreadyRunning = existing.some(candidate => candidate.userDataDir && path.resolve(candidate.userDataDir) === profileDir);
    if (alreadyRunning) {
      return {
        attempted: true,
        launched: false,
        already_running: true,
        browser_name: "Edge",
        profile_dir: profileDir,
        profile_name: path.basename(profileDir),
        message: "dedicated browser is already running but its debugging endpoint is not ready",
      };
    }
    let launch;
    try {
      launch = launchBrowser(args);
    } catch (error) {
      return { attempted: true, launched: false, error: String(error) };
    }
    if (!launch.launched) return { attempted: true, ...launch };
    const endpoint = await waitForDebugEndpoint(launch.port);
    return {
      attempted: true,
      ...launch,
      ready: Boolean(endpoint),
      message: endpoint
        ? "dedicated browser is ready"
        : "dedicated browser was started but its debugging endpoint is not ready yet",
    };
  })().finally(() => {
    pendingDedicatedLaunch = null;
  });
  return pendingDedicatedLaunch;
}

async function browserStatus(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  try {
    const targets = await listTargets(port);
    return jsonResult("browser is reachable", {
      connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      port,
      route_id: activeRouteId,
      route_status: activeRoute?.status || "idle",
      session_id: activeSessionId,
      brain_provider: provider.id,
      assigned_target_id: activeSession?.target_id || null,
      assigned_conversation_id: activeSession?.conversation?.id || null,
      targets: targets.map(item => ({
        id: item.id,
        type: item.type,
        title: item.title,
        url: item.url,
        conversation_id: conversationIdFromUrl(item.url || "", provider.id),
        brain_provider: providerMatchesUrl(provider, item.url) ? provider.id : null,
        claimed_by_session: listStoredSessions().find(session => session.target_id === item.id)?.session_id || null,
        claimed_by_route: listRoutes().find(route => route.target_id === item.id)?.route_id || null,
      })),
    });
  } catch (error) {
    return jsonResult("browser is not reachable; launch the dedicated browser first", {
      connected: false,
      port,
      route_id: activeRouteId,
      route_status: activeRoute?.status || "idle",
      session_id: activeSessionId,
      error: String(error),
      launch: `chatgpt_browser_launch with port ${port}`,
    });
  }
}

function discoveryPorts(args = {}) {
  const values = [];
  const add = value => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !values.includes(port)) values.push(port);
  };
  if (Array.isArray(args.ports)) args.ports.forEach(add);
  add(args.port);
  add(process.env.CHATGPT_BRIDGE_PORT);
  [DEFAULT_PORT, 9223, 9224, 9225, 9333].forEach(add);
  return values;
}

async function windowIdsForTargets(version = {}, targets = []) {
  const url = version.webSocketDebuggerUrl;
  const pages = targets.filter(item => item?.type === "page" && item.id);
  if (!url || !pages.length) return {};
  return new Promise(resolve => {
    let ws;
    const results = {};
    const pendingIds = new Set();
    const pageByRequestId = new Map();
    let nextId = 1;
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(results);
    };
    try {
      ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        for (const page of pages) {
          const id = nextId++;
          pageByRequestId.set(id, page);
          pendingIds.add(id);
          ws.send(JSON.stringify({ id, method: "Browser.getWindowForTarget", params: { targetId: page.id } }));
        }
        timer = setTimeout(finish, 2500);
      }, { once: true });
      ws.addEventListener("message", event => {
        try {
          const message = JSON.parse(String(event.data));
          if (!pendingIds.has(message.id)) return;
          pendingIds.delete(message.id);
          const page = pageByRequestId.get(message.id);
          if (page && message.result?.windowId !== undefined) results[page.id] = String(message.result.windowId);
          if (!pendingIds.size) finish();
        } catch {}
      });
      ws.addEventListener("error", finish, { once: true });
      ws.addEventListener("close", () => {
        if (pendingIds.size) finish();
      }, { once: true });
    } catch {
      finish();
    }
  });
}

async function activateTargetOnBrowser(version = {}, targetId = "") {
  const url = version.webSocketDebuggerUrl;
  if (!url || !targetId) return false;
  return new Promise(resolve => {
    let ws;
    let timer;
    const finish = value => {
      if (timer) clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(Boolean(value));
    };
    try {
      ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        timer = setTimeout(() => finish(false), 2500);
        ws.send(JSON.stringify({ id: 1, method: "Target.activateTarget", params: { targetId } }));
      }, { once: true });
      ws.addEventListener("message", event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) finish(!message.error && message.result?.success !== false);
        } catch { finish(false); }
      });
      ws.addEventListener("error", () => finish(false), { once: true });
      ws.addEventListener("close", () => finish(false), { once: true });
    } catch {
      finish(false);
    }
  });
}

async function localEdgeProcessCandidates() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "[]"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = [];
    const seen = new Set();
    for (const row of rows) {
      const commandLine = String(row?.CommandLine || "");
      if (!commandLine) continue;
      if (/\s--type=/i.test(commandLine)) continue;
      const profileMatch = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i);
      const portMatch = commandLine.match(/--remote-debugging-port=(\d+)/i);
      const key = profileMatch?.[1] || profileMatch?.[2] || "default-profile";
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        userDataDir: key.startsWith("pid:") ? "" : key,
        port: portMatch ? Number(portMatch[1]) : null,
        processId: String(row?.ProcessId || ""),
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function discoverBrowserInstances(args = {}) {
  const instances = [];
  const processCandidates = await localEdgeProcessCandidates();
  for (const port of discoveryPorts(args)) {
    try {
      const [version, targets] = await Promise.all([
        getJson(`http://127.0.0.1:${port}/json/version`).catch(() => ({})),
        listTargets(port),
      ]);
      if (!Array.isArray(targets)) continue;
      const windowByTarget = await windowIdsForTargets(version, targets);
      instances.push(browserInstanceFromEndpoint({ port, version, targets, windowByTarget, index: instances.length + 1 }));
    } catch {}
  }
  const connectedPorts = new Set(instances.map(instance => instance.port));
  for (const candidate of processCandidates) {
    if (candidate.port && connectedPorts.has(candidate.port)) continue;
    instances.push(undebuggableBrowserInstance({
      index: instances.length + 1,
      userDataDir: candidate.userDataDir,
      processId: candidate.processId,
    }));
  }
  return instances;
}

async function discoverForUser(args = {}) {
  let instances = await discoverBrowserInstances(args);
  let automaticLaunch = { attempted: false, launched: false };
  if (!instances.some(instance => instance.debugging) && args.auto_launch !== false) {
    automaticLaunch = await launchDedicatedBrowserIfNeeded(args);
    if (automaticLaunch.launched) instances = await discoverBrowserInstances(args);
  }
  return { instances, automaticLaunch };
}

function browserInstanceSelection(instances, selector = "") {
  const wanted = String(selector || "").trim();
  if (!wanted) {
    const debuggable = instances.filter(instance => instance.debugging);
    if (debuggable.length === 1) return debuggable[0];
    const error = new Error(debuggable.length > 1
      ? "more than one debuggable browser is available; choose a browser by number or name"
      : "no debuggable browser was found");
    error.code = debuggable.length > 1 ? "BROWSER_SELECTION_REQUIRED" : "BROWSER_NOT_FOUND";
    error.browsers = publicBrowserChoices(instances);
    throw error;
  }
  const numeric = /^\d+$/.test(wanted) ? Number(wanted) : null;
  const matches = numeric
    ? instances.filter((_, index) => index + 1 === numeric)
    : instances.filter(instance => instance.browser_instance === wanted || instance.browser_instance.toLowerCase() === wanted.toLowerCase());
  if (matches.length > 1) {
    const error = new Error(`browser selector is ambiguous: ${wanted}`);
    error.code = "BROWSER_AMBIGUOUS";
    throw error;
  }
  if (!matches[0]) {
    const error = new Error(`browser was not found: ${wanted}`);
    error.code = "BROWSER_NOT_FOUND";
    error.browsers = publicBrowserChoices(instances);
    throw error;
  }
  return matches[0];
}

function publicBridgeLink(extra = {}) {
  if (!activeBridgeLink) return {
    state: "idle",
    connected: false,
    message: "还没有网页端连接。可以说“连接 ChatGPT 网页端”开始扫描。",
  };
  const workspace = activeBridgeLink.workspace || activeRoute?.workspace || null;
  return {
    state: activeBridgeLink.state,
    connected: ["ready", "connected", "running", "awaiting_goal"].includes(activeBridgeLink.state),
    provider: activeBridgeLink.provider,
    executor_host: activeRoute?.executor_provider || DEFAULT_EXECUTOR_PROVIDER,
    executor_model: activeRoute?.executor_model || null,
    executor_endpoint: activeRoute?.executor_endpoint || null,
    browser: activeBridgeLink.browser,
    window: activeBridgeLink.window,
    tab: activeBridgeLink.tab,
    conversation: activeBridgeLink.conversation,
    workspace: workspace ? {
      name: workspace.name
        || workspace.root
        || null,
      github: Boolean(workspace.github),
      branch: workspace.branch || null,
      changes: Array.isArray(workspace.changes)
        ? workspace.changes.length
        : 0,
    } : null,
    mode: activeBridgeLink.config ? userFacingRelayMode(activeBridgeLink.config) : null,
    direction: activeBridgeLink.config?.direction || null,
    rounds: activeBridgeLink.config?.rounds ?? null,
    goal: activeBridgeLink.goal || activeBridgeLink.config?.goal || brainState.goal || "",
    goal_source: activeBridgeLink.config?.goal_source || brainState.goal_source || "none",
    codex_binding: codexBindingView(activeRoute),
    goal_status: activeBridgeLink.goal || activeBridgeLink.config?.goal || brainState.goal
      ? "attached"
      : activeBridgeLink.state === "awaiting_goal" ? "awaiting_user" : "none",
    native_goal: activeBridgeLink.native_goal || activeRoute?.native_goal || null,
    browser_health: activeRoute?.browser_health ? {
      state: activeRoute.browser_health.state || "unknown",
      message: activeRoute.browser_health.message || null,
      checked_at: activeRoute.browser_health.checked_at || null,
    } : null,
    run: activeBridgeRun ? {
      state: activeBridgeRun.state,
      status: activeBridgeRun.status || null,
      round: activeBridgeRun.round ?? activeBridgeLink.round ?? 0,
      started_at: activeBridgeRun.started_at,
      finished_at: activeBridgeRun.finished_at || null,
      error: activeBridgeRun.error || null,
    } : null,
    failure: activeBridgeLink.failure || null,
    requires_goal: !Boolean(activeBridgeLink.goal || activeBridgeLink.config?.goal || brainState.goal)
      && ["awaiting_goal", "connected", "ready"].includes(activeBridgeLink.state),
    ...extra,
  };
}

async function bridgeDiscover(args = {}) {
  const { instances, automaticLaunch } = await discoverForUser(args);
  const choices = publicBrowserChoices(instances);
  const launchMessage = automaticLaunch.launched
    ? `未发现可连接的浏览器，已自动打开专用${automaticLaunch.browser_name || "浏览器"}（${automaticLaunch.profile_name || "CodexBridgeEdge"}）。`
    : automaticLaunch.already_running
      ? `专用${automaticLaunch.browser_name || "浏览器"}已经在运行，但网页连接端点尚未准备好；不会重复启动浏览器，请稍后重试。`
    : automaticLaunch.attempted && !automaticLaunch.launched
      ? "未发现可连接的浏览器，自动启动专用 Edge 失败。"
      : "";
  return jsonResult([launchMessage, discoveryText(instances)].filter(Boolean).join("\n"), {
    discovered: instances.some(instance => instance.debugging),
    browsers: choices,
    auto_launched: Boolean(automaticLaunch.launched),
    auto_launch_ready: automaticLaunch.ready ?? false,
    next: instances.some(instance => instance.debugging)
      ? "选择浏览器和标签页后建立连接；如果网页要求登录，请登录后告诉我“登录好了”"
      : "请重试连接，或检查 Edge 是否安装",
  }, false);
}

async function bridgeFocus(args = {}) {
  const instances = await discoverBrowserInstances(args);
  let instance;
  try {
    instance = browserInstanceSelection(instances, args.browser);
  } catch (error) {
    return jsonResult(String(error), { focused: false, browsers: publicBrowserChoices(instances) }, true);
  }
  if (!instance.debugging) return jsonResult("这个 Edge 尚未允许网页连接，无法定位标签页", { focused: false, browser: instance.browser_instance }, true);
  let selectedWindow;
  let tab;
  try {
    selectedWindow = args.window ? selectWindow(instance, args.window) : null;
    tab = selectedWindow ? selectTabInWindow(instance, selectedWindow.window, args.tab) : selectTab(instance, args.tab);
  } catch (error) {
    return jsonResult(String(error), { focused: false, browser: instance.browser_instance, windows: error.windows || [], tabs: error.tabs || [] }, true);
  }
  selectedWindow ||= instance.windows.find(window => window.tabs.some(candidate => candidate.target_id === tab.target_id));
  const version = await getJson(`http://127.0.0.1:${instance.port}/json/version`).catch(() => ({}));
  const focused = await activateTargetOnBrowser(version, tab.target_id);
  return jsonResult(
    focused ? `已定位到${instance.browser_instance} · ${tab.title}` : "无法定位这个标签页",
    { focused, browser: instance.browser_instance, window: selectedWindow?.window || null, tab: { tab_index: tab.tab_index, title: tab.title, url: tab.url } },
    !focused,
  );
}

function internalBridgeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function bridgeTabChoices(instance, provider, windowSelector = "") {
  const windows = windowSelector ? [selectWindow(instance, windowSelector)] : instance.windows;
  return windows.flatMap(window => window.tabs.map(tab => ({ ...tab, window: window.window })))
    .filter(tab => providerMatchesUrl(provider, tab.url))
    .map(tab => ({ window: tab.window, tab_index: tab.tab_index, title: tab.title, url: tab.url }));
}

async function bridgeConnect(args = {}) {
  if (!args.resume && activeBridgeRun?.state === "running") {
    return jsonResult("已有网页端循环正在运行；请先暂停或断开当前连接，再建立新的 Codex ↔ 网页端绑定", publicBridgeLink({ connected: false, state: "running", connection_blocked: true }), true);
  }
  if (args.resume && activeBridgeLink) {
    const health = await browserHealth({
      route_id: activeBridgeLink.route_id,
      session_id: activeBridgeLink.session_id,
      brain_provider: activeBridgeLink.provider === "DeepSeek Web" ? "deepseek" : "chatgpt",
      port: activeBridgeLink.port,
    });
    const healthy = Boolean(health.structuredContent?.healthy);
    const hasGoal = Boolean(activeBridgeLink.goal || activeBridgeLink.config?.goal || brainState.goal);
    if (healthy && activeRelayEngine?.status?.().state === "paused") {
      const resumed = await activeRelayEngine.resume?.("用户确认已修复网页连接");
      if (!resumed?.resumed) {
        return jsonResult("网页连接仍处于暂停状态，请先断开并重新连接", publicBridgeLink({
          state: "paused",
          requires_resume: true,
        }), true);
      }
      activeBridgeLink.failure = null;
    }
    const relayState = activeRelayEngine?.status?.().state;
    activeBridgeLink.state = healthy
      ? (relayState === "completed" ? "completed" : hasGoal ? "connected" : "awaiting_goal")
      : "waiting_for_login";
    return jsonResult(
      healthy
        ? (hasGoal ? "网页端已准备好，可以继续" : "网页端已连接。请告诉我你希望 Codex 完成什么，我会把你的回答创建为本次桥接目标")
        : "网页端仍未准备好，请在可见浏览器中完成登录或页面准备",
      publicBridgeLink({ requires_login: !healthy, requires_goal: healthy && !hasGoal }),
      false,
    );
  }
  let config;
  let provider;
  try {
    config = normalizeRelayConfig({
      ...args,
      goal_source: args.goal_source || (args.goal ? "explicit" : "plugin_question"),
    });
    provider = getBrainProvider(args.provider || args.brain_provider || DEFAULT_BRAIN_PROVIDER);
  } catch (error) {
    return jsonResult(String(error), { connected: false, state: "idle" }, true);
  }
  const { instances, automaticLaunch } = await discoverForUser(args);
  let instance;
  try {
    instance = browserInstanceSelection(instances, args.browser);
  } catch (error) {
    return jsonResult(String(error), {
      connected: false,
      state: "discovering",
      browsers: publicBrowserChoices(instances),
      auto_launched: Boolean(automaticLaunch.launched),
      auto_launch_ready: automaticLaunch.ready ?? false,
    }, true);
  }
  if (!instance.debugging) {
    return jsonResult("检测到 Edge，但它尚未允许网页调试连接。请在浏览器中开启网页连接，或选择专用浏览器。", {
      connected: false,
      state: "browser_selected",
      browser: instance.browser_instance,
      action: "enable_browser_debugging_or_launch_dedicated_profile",
    }, true);
  }
  let selectedWindow;
  let tab;
  try {
    selectedWindow = args.window ? selectWindow(instance, args.window) : null;
    const windows = selectedWindow ? [selectedWindow] : instance.windows;
    const allTabs = windows.flatMap(window => window.tabs.map(candidate => ({ ...candidate, window: window.window })));
    if (args.tab) {
      tab = selectedWindow ? selectTabInWindow(instance, selectedWindow.window, args.tab) : selectTab(instance, args.tab);
      if (!providerMatchesUrl(provider, tab.url)) {
        const error = new Error(`所选标签页不是 ${provider.display_name}，请选择对应网页端标签页`);
        error.code = "BROWSER_TAB_PROVIDER_MISMATCH";
        error.tabs = bridgeTabChoices(instance, provider, selectedWindow?.window || "");
        throw error;
      }
    } else {
      const candidates = allTabs.filter(candidate => providerMatchesUrl(provider, candidate.url));
      if (candidates.length !== 1) {
        const error = new Error(candidates.length
          ? `发现多个 ${provider.display_name} 标签页，请选择一个`
          : `没有发现 ${provider.display_name} 标签页，请先打开 ${provider.start_url}`);
        error.code = candidates.length ? "BROWSER_TAB_SELECTION_REQUIRED" : "BROWSER_TAB_NOT_FOUND";
        error.tabs = candidates.map(candidate => ({ window: candidate.window, tab_index: candidate.tab_index, title: candidate.title, url: candidate.url }));
        throw error;
      }
      tab = candidates[0];
    }
    selectedWindow ||= instance.windows.find(window => window.tabs.some(candidate => candidate.target_id === tab.target_id));
  } catch (error) {
    return jsonResult(String(error), {
      connected: false,
      state: "browser_selected",
      browser: instance.browser_instance,
      windows: error.windows || [],
      tabs: error.tabs || bridgeTabChoices(instance, provider, error.code?.startsWith("BROWSER_WINDOW_") ? "" : (args.window || "")),
    }, true);
  }

  const sessionId = args.__session_id || internalBridgeId("link-session");
  const routeId = args.__route_id || internalBridgeId("link-route");
  const sessionResult = createSession({ session_id: sessionId, name: "网页端连接", brain_provider: provider.id });
  if (sessionResult.isError) return sessionResult;
  const routeResult = routeCreate({
    route_id: routeId,
    name: "网页端连接",
    session_id: sessionId,
    brain_provider: provider.id,
    executor_provider: args.executor_provider,
    executor_model: args.executor_model,
    executor_profile: args.executor_profile,
    executor_endpoint: args.executor_endpoint,
    executor_agent: args.executor_agent,
    __host_codex_context: hostCodexContextOf(args),
  });
  if (routeResult.isError) return routeResult;
  activeRouteId = routeId;
  activeRoute = readRoute(routeId);

  // Bind the current local repository as route context. This is metadata-only:
  // it does not pull, push, commit, or contact GitHub. The planning brain can
  // use the same branch/change evidence that Codex sees locally.
  let workspace = null;
  try {
    const workspaceResult = await inspectGithubWorkspace({ cwd: args.cwd || process.cwd() });
    workspace = compactWorkspaceBinding(workspaceResult);
    if (workspace) {
      activeRoute = updateRoute(routeId, { workspace, last_action: "github_workspace_auto_bind" });
      appendRouteEvent(routeId, {
        type: "WORKSPACE_AUTO_BOUND",
        summary: `workspace auto-bound: ${workspace.name || workspace.root || "local repository"}`,
        data: { github: workspace.github, branch: workspace.branch, changes: workspace.changes.length },
      });
    }
  } catch {}

  activeBridgeLink = {
    state: "browser_selected",
    provider_id: provider.id,
    provider: provider.display_name,
    browser: instance.browser_instance,
    window: selectedWindow?.window || null,
    tab: { tab_index: tab.tab_index, title: tab.title, url: tab.url },
    conversation: null,
    config,
    session_id: sessionId,
    route_id: routeId,
    port: instance.port,
    workspace,
  };
  const bridgeLink = activeBridgeLink;
  activeRelayEngine = createRelayEngine({
    config,
    relayId: routeId,
    verifyDestination: () => verifyBridgeDestination(),
    sendMessage: async envelope => {
      const result = await askBrain({
        route_id: routeId,
        session_id: sessionId,
        brain_provider: provider.id,
        port: instance.port,
        prompt: `[Codex Bridge Message]\nOrigin: Codex\nRelay Round: ${envelope.turn_index}\n\n<content>\n${envelope.content}\n</content>`,
      });
      if (result.isError) throw new Error(resultText(result));
      return { reply: resultText(result), raw: result };
    },
    receiveMessage: async () => {
      const snapshot = await pageSnapshot(provider);
      return { content: snapshot.last, source_message_id: snapshot.url };
    },
    executeRound: async roundArgs => {
      const result = await runRound({
        route_id: routeId,
        session_id: sessionId,
        brain_provider: provider.id,
        goal: roundArgs.goal,
        context: roundArgs.context,
        constraints: roundArgs.constraints,
        workspace_state: workspacePromptState(workspace),
        continuous: config.mode === "continuous",
        max_rounds: config.mode === "continuous" ? undefined : config.rounds,
        port: instance.port,
      });
      return result.structuredContent || result;
    },
    onStateChange: next => {
      if (activeBridgeLink !== bridgeLink) return;
      bridgeLink.state = next.state;
      bridgeLink.round = next.round;
    },
  });
  const opened = await openBrainBrowser({
    route_id: routeId,
    session_id: sessionId,
    brain_provider: provider.id,
    port: instance.port,
    target_id: tab.target_id,
  });
  if (opened.isError) {
    activeBridgeLink.state = "disconnected";
    return jsonResult(resultText(opened), publicBridgeLink({ reason: "网页标签页连接失败" }), true);
  }

  if (args.conversation) {
    const conversationArgs = /^https?:\/\//i.test(String(args.conversation))
      ? { url: args.conversation }
      : { title: args.conversation };
    const selected = await selectConversation({
      ...conversationArgs,
      route_id: routeId,
      session_id: sessionId,
      brain_provider: provider.id,
      port: instance.port,
    });
    if (selected.isError) {
      activeBridgeLink.state = "paused";
      return jsonResult(resultText(selected), publicBridgeLink({ reason: "无法确认目标对话" }), true);
    }
  }
  activeBridgeLink.conversation = selectedConversation
    ? { title: selectedConversation.title || "当前对话", url: selectedConversation.url || "" }
    : null;

  const health = await browserHealth({
    route_id: routeId,
    session_id: sessionId,
    brain_provider: provider.id,
    port: instance.port,
  });
  const healthy = Boolean(health.structuredContent?.healthy);
  activeBridgeLink.state = healthy ? "awaiting_goal" : "waiting_for_login";
  return jsonResult(
    healthy
      ? `${provider.display_name} 已连接：${tab.title}。请告诉我你希望 Codex 完成什么，我会把你的回答创建为本次桥接目标`
      : `${provider.display_name} 标签页已找到，请在浏览器中登录或完成页面准备后告诉我“登录好了”`,
    publicBridgeLink({ requires_login: !healthy, requires_goal: healthy, reason: healthy ? "等待用户回答目标问题" : "需要用户在可见浏览器中完成登录" }),
    false,
  );
}

function bridgeStatus() {
  return jsonResult("网页端连接状态", publicBridgeLink());
}

async function pauseActiveBridge(reason, code = "BRIDGE_FAILURE") {
  if (!activeBridgeLink) return;
  await activeRelayEngine?.pause?.(reason);
  activeBridgeLink.state = "paused";
  activeBridgeLink.failure = {
    code,
    reason: String(reason || "网页桥接失败"),
    at: new Date().toISOString(),
  };
  persistActiveSession();
  syncActiveRoute({ status: "paused", last_action: "bridge_paused" });
  appendRouteEvent(activeBridgeLink.route_id, {
    type: "BRIDGE_PAUSED",
    summary: activeBridgeLink.failure.reason,
    data: { code },
  });
}

// Internal-only runtime facts used by the parent Swarm coordinator. This name
// is intentionally absent from TOOLS, so ordinary users never receive route,
// session, target, or port identifiers.
function bridgeWorkerRuntimeStatus() {
  return jsonResult("internal bridge worker runtime", {
    available: Boolean(activeBridgeLink),
    route_id: activeBridgeLink?.route_id || null,
    session_id: activeBridgeLink?.session_id || activeSessionId || null,
    port: activeBridgeLink?.port || null,
    target_id: activeSession?.target_id || null,
    provider: activeBridgeLink?.provider_id || null,
    target_title: activeBridgeLink?.tab?.title || null,
    target_url: activeBridgeLink?.tab?.url || null,
  });
}

function swarmMemberConfig(raw = {}, cwd) {
  const provider = raw.provider || raw.brain_provider || DEFAULT_BRAIN_PROVIDER;
  const config = {
    provider,
    browser: raw.browser,
    window: raw.window,
    tab: raw.tab,
    conversation: raw.conversation,
    mode: raw.mode || "one_shot",
    rounds: raw.rounds,
    direction: raw.direction || "codex_to_web",
    auto_launch: raw.auto_launch === true,
    executor_provider: raw.executor_provider,
    executor_model: raw.executor_model,
    executor_profile: raw.executor_profile,
    executor_endpoint: raw.executor_endpoint,
    executor_agent: raw.executor_agent,
    cwd,
  };
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function swarmLinkState(link) {
  const state = String(link?.state || "preparing");
  if (link?.run?.state === "running" || state === "running") return "running";
  if (["paused", "disconnected", "worker_unavailable", "duplicate_target"].includes(state)) return state;
  if (state === "waiting_for_login") return "waiting_for_login";
  if (state === "awaiting_goal") return "awaiting_goal";
  if (["connected", "ready"].includes(state)) return "ready";
  return state;
}

function swarmWatchdogFailure(state) {
  return [
    "browser_unreachable",
    "page_unresponsive",
    "composer_missing",
    "selector_degraded",
    "generation_timeout",
    "provider_tab_not_found",
    "target_selection_required",
    "watchdog_error",
  ].includes(String(state || ""));
}

function swarmSafeMessage(value, fallback = "网页会话已暂停，需要人工检查原标签页") {
  const message = String(value || fallback)
    .replace(/\b(route|session|target|swarm|worker)[-_][A-Za-z0-9._-]+\b/gi, "$1-id")
    .slice(0, 500);
  return message || fallback;
}

function swarmPublicLink(result) {
  const link = result?.structuredContent;
  if (!link || typeof link !== "object") return null;
  return {
    state: link.state || "preparing",
    connected: Boolean(link.connected),
    provider: link.provider || null,
    browser: link.browser || null,
    window: link.window || null,
    tab: link.tab || null,
    conversation: link.conversation || null,
    workspace: link.workspace || null,
    mode: link.mode || null,
    direction: link.direction || null,
    rounds: link.rounds ?? null,
    goal_status: link.goal_status || "none",
    run: link.run ? {
      state: link.run.state || null,
      status: link.run.status || null,
      round: link.run.round ?? 0,
      started_at: link.run.started_at || null,
      finished_at: link.run.finished_at || null,
      error: link.run.error ? swarmSafeMessage(link.run.error) : null,
    } : null,
    browser_health: link.browser_health || null,
  };
}

function swarmFailure(state, message) {
  return {
    state: String(state || "unknown"),
    message: swarmSafeMessage(message),
    at: new Date().toISOString(),
  };
}

function swarmWorkerArgs(swarm, member, extra = {}) {
  return {
    ...(member.config || {}),
    ...extra,
    __host_codex_context: workerContextOf(swarm, member),
  };
}

async function swarmWorkerCall(swarm, member, name, extra = {}, timeoutMs = 10 * 60 * 1000) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) throw new Error("网页会话组只能由 MCP 控制面运行");
  return routeWorkerPool.call(name, swarmWorkerArgs(swarm, member, extra), { timeoutMs });
}

function swarmAggregateState(swarm) {
  if (swarm.state === "stopped") return "stopped";
  const states = (swarm.members || []).map(member => member.state);
  if (!states.length) return "preparing";
  if (states.some(state => ["paused", "failed", "worker_unavailable", "duplicate_target"].includes(state))) return "paused";
  if (states.some(state => state === "running")) return "running";
  if (states.every(state => state === "completed")) return "completed";
  if (states.some(state => state === "waiting_for_login")) return "waiting_for_login";
  if (states.some(state => state === "awaiting_goal")) return "awaiting_goal";
  if (states.every(state => ["ready", "completed"].includes(state))) return "ready";
  return "partial";
}

async function pauseSwarmMember(swarm, member, state, message) {
  if (member.state !== "paused" || member.failure?.state !== state) {
    try { await swarmWorkerCall(swarm, member, "bridge_pause", {}, 2 * 60 * 1000); } catch {}
  }
  member.state = "paused";
  member.failure = swarmFailure(state, message);
}

async function startSwarmWatchdog(swarm, member) {
  const runtime = member.runtime;
  if (!runtime?.port) return;
  const result = await swarmWorkerCall(swarm, member, "browser_watchdog_start", {
    name: member.watchdog_name,
    provider: member.config.provider || DEFAULT_BRAIN_PROVIDER,
    port: runtime.port,
    target_title: runtime.target_title || member.link?.tab?.title,
    target_url: runtime.target_url || member.link?.tab?.url,
    route_id: runtime.route_id,
    interval_ms: swarm.watchdog?.interval_ms,
    generation_timeout_ms: swarm.watchdog?.generation_timeout_ms,
  }, 2 * 60 * 1000);
  const watchdog = result?.structuredContent?.watchdog;
  if (watchdog) member.watchdog = watchdog;
  const healthState = watchdog?.last_result?.state || watchdog?.state;
  if (swarmWatchdogFailure(healthState)) {
    await pauseSwarmMember(swarm, member, healthState, watchdog?.last_alert?.message || watchdog?.last_result?.message || "网页守护检测失败");
  }
}

async function connectSwarmMember(swarm, member, { resume = false } = {}) {
  // A fresh route/session pair is used on every explicit recovery. If the
  // worker is still alive, bridge_connect(resume) keeps its original target;
  // if it restarted, the saved human selectors are used to reconnect the same
  // target instead of silently selecting another one.
  member.route_id = internalBridgeId("swarm-route");
  member.session_id = internalBridgeId("swarm-session");
  member.failure = null;
  const result = await swarmWorkerCall(swarm, member, "bridge_connect", {
    ...member.config,
    resume: Boolean(resume),
    __route_id: member.route_id,
    __session_id: member.session_id,
  }, 10 * 60 * 1000);
  const link = swarmPublicLink(result);
  if (link) member.link = link;
  if (result?.isError) {
    const state = link ? swarmLinkState(link) : "paused";
    member.state = state === "waiting_for_login" ? state : "paused";
    if (member.state === "paused") member.failure = swarmFailure(state, resultText(result));
    return result;
  }
  member.state = swarmLinkState(link);
  const runtimeResult = await swarmWorkerCall(swarm, member, "bridge_worker_runtime_status", {}, 60 * 1000);
  const runtime = runtimeResult?.structuredContent;
  if (!runtime?.available) {
    await pauseSwarmMember(swarm, member, "worker_unavailable", "网页会话 worker 未返回运行状态");
    return result;
  }
  member.runtime = runtime;
  const duplicate = runtime.target_id && swarm.members.some(other => other !== member && other.runtime?.target_id === runtime.target_id);
  if (duplicate) {
    await pauseSwarmMember(swarm, member, "duplicate_target", "多个网页会话选择了同一个浏览器标签页；没有切换或重发消息");
    return result;
  }
  try {
    await startSwarmWatchdog(swarm, member);
  } catch (error) {
    await pauseSwarmMember(swarm, member, "watchdog_error", String(error));
  }
  return result;
}

async function syncSwarm(swarm) {
  if (swarm.state === "stopped") return swarm;
  for (const member of swarm.members || []) {
    try {
      const status = await swarmWorkerCall(swarm, member, "bridge_status", {}, 2 * 60 * 1000);
      const link = swarmPublicLink(status);
      if (link) member.link = link;
      const watchdogResult = await swarmWorkerCall(swarm, member, "browser_watchdog_status", { name: member.watchdog_name }, 60 * 1000);
      const watchdog = watchdogResult?.structuredContent?.watchdogs?.[0];
      if (watchdog) member.watchdog = watchdog;
      const healthState = watchdog?.last_result?.state || watchdog?.state || link?.browser_health?.state;
      if (swarmWatchdogFailure(healthState) && member.state !== "paused") {
        await pauseSwarmMember(swarm, member, healthState, watchdog?.last_alert?.message || watchdog?.last_result?.message || "网页守护检测失败");
      } else if (member.state !== "paused" && member.state !== "duplicate_target") {
        member.state = swarmLinkState(link);
      }
    } catch (error) {
      if (member.state !== "paused") await pauseSwarmMember(swarm, member, "worker_unavailable", "网页会话 worker 不可用，已暂停整个会话组");
      member.failure ||= swarmFailure("worker_unavailable", String(error));
    }
  }
  swarm.state = swarmAggregateState(swarm);
  return writeSwarm(swarm);
}

function resolveSwarm(name) {
  const swarm = findSwarmByName(name);
  if (!swarm) throw new Error(`没有找到网页会话组：${name}`);
  return swarm;
}

function selectSwarmMembers(swarm, label) {
  if (!String(label || "").trim()) return [...(swarm.members || [])];
  const member = memberByLabel(swarm, label);
  if (!member) throw new Error(`会话组“${swarm.name}”中没有找到网页会话：${label}`);
  return [member];
}

async function bridgeSwarmCreate(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组只能由 MCP 控制面创建", { created: false }, true);
  const name = String(args.name || args.label || "").trim().slice(0, 100);
  if (!name) return jsonResult("请提供网页会话组名称", { created: false }, true);
  if (findSwarmByName(name)) return jsonResult(`网页会话组已存在：${name}`, { created: false }, true);
  const members = Array.isArray(args.members) ? args.members : [];
  if (!members.length) return jsonResult("请提供至少一个网页会话配置；先用 bridge_discover 查看浏览器和标签页", { created: false }, true);
  if (members.length > maxMembers()) return jsonResult(`网页会话组最多支持 ${maxMembers()} 个会话`, { created: false }, true);
  const cwd = args.cwd || process.cwd();
  const workspaceResult = await inspectGithubWorkspace({ cwd });
  if (!workspaceResult.ok) return jsonResult("网页会话组要求绑定一个可读取的本地 Git 工作区", { created: false, workspace: workspaceResult }, true);
  const workspace = compactWorkspaceBinding(workspaceResult);
  const group = newSwarmRecord({
    id: internalBridgeId("swarm"),
    name,
    cwd,
    workspace,
    watchdog: {
      interval_ms: Math.min(Math.max(Number(args.interval_ms) || 15000, 5000), 10 * 60 * 1000),
      generation_timeout_ms: Math.min(Math.max(Number(args.generation_timeout_ms) || 180000, 15000), 30 * 60 * 1000),
    },
  });
  const labels = new Set();
  for (const [index, raw] of members.entries()) {
    const label = String(raw?.label || raw?.name || `网页会话 ${index + 1}`).trim().slice(0, 80);
    const key = label.toLocaleLowerCase();
    if (labels.has(key)) return jsonResult(`网页会话组中存在重复名称：${label}`, { created: false }, true);
    labels.add(key);
    const config = swarmMemberConfig(raw, cwd);
    const member = {
      member_id: internalBridgeId("swarm-member"),
      label,
      config,
      provider: config.provider,
      browser: config.browser || null,
      window: config.window || null,
      tab: config.tab || null,
      conversation: config.conversation || null,
      mode: config.mode || null,
      direction: config.direction || null,
      rounds: config.rounds ?? null,
      worker_context: internalBridgeId("swarm-worker"),
      route_id: null,
      session_id: null,
      runtime: null,
      watchdog_name: internalBridgeId("swarm-watchdog"),
      watchdog: { lifecycle: "not_started", state: "unknown", checks: 0, alert_count: 0 },
      link: null,
      state: "preparing",
      failure: null,
    };
    group.members.push(member);
  }
  writeSwarm(group);
  for (const member of group.members) {
    try {
      await connectSwarmMember(group, member);
    } catch (error) {
      await pauseSwarmMember(group, member, "connect_failed", String(error));
    }
    group.state = swarmAggregateState(group);
    writeSwarm(group);
  }
  group.state = swarmAggregateState(group);
  writeSwarm(group);
  appendSwarmEvent(group.swarm_id, { type: "SWARM_CREATED", summary: `created swarm ${group.name}` });
  return jsonResult(`已创建网页会话组：${group.name}`, { created: true, swarm: publicSwarm(readSwarm(group.swarm_id)) });
}

async function bridgeSwarmStatus(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组状态只能由 MCP 控制面读取", { swarms: [] }, true);
  const wanted = String(args.name || args.label || "").trim();
  if (!wanted) {
    const swarms = await Promise.all(listSwarms().map(swarm => syncSwarm(swarm).catch(() => swarm)));
    return jsonResult("网页会话组状态", { swarms: swarms.map(publicSwarm) });
  }
  try {
    const swarm = await syncSwarm(resolveSwarm(wanted));
    return jsonResult(`网页会话组：${swarm.name}`, { swarm: publicSwarm(swarm) }, false);
  } catch (error) {
    return jsonResult(String(error), { swarm: null }, true);
  }
}

async function bridgeSwarmResume(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组只能由 MCP 控制面恢复", { resumed: false }, true);
  let swarm;
  try { swarm = resolveSwarm(args.name || args.label); } catch (error) { return jsonResult(String(error), { resumed: false }, true); }
  if (swarm.state === "stopped") return jsonResult("这个网页会话组已经停止，请创建新的会话组", { resumed: false, swarm: publicSwarm(swarm) }, true);
  let selected;
  try { selected = selectSwarmMembers(swarm, args.member); } catch (error) { return jsonResult(String(error), { resumed: false, swarm: publicSwarm(swarm) }, true); }
  for (const member of selected) {
    try {
      await connectSwarmMember(swarm, member, { resume: true });
    } catch (error) {
      await pauseSwarmMember(swarm, member, "resume_failed", String(error));
    }
  }
  swarm.state = swarmAggregateState(swarm);
  writeSwarm(swarm);
  appendSwarmEvent(swarm.swarm_id, { type: "SWARM_RESUMED", summary: `resumed ${args.member || "all members"}` });
  return jsonResult(`网页会话组已尝试恢复：${swarm.name}`, { resumed: true, swarm: publicSwarm(readSwarm(swarm.swarm_id)) }, false);
}

async function bridgeSwarmPause(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组只能由 MCP 控制面暂停", { paused: false }, true);
  let swarm;
  try { swarm = resolveSwarm(args.name || args.label); } catch (error) { return jsonResult(String(error), { paused: false }, true); }
  let selected;
  try { selected = selectSwarmMembers(swarm, args.member); } catch (error) { return jsonResult(String(error), { paused: false }, true); }
  for (const member of selected) await pauseSwarmMember(swarm, member, "user_pause", args.reason || "用户暂停网页会话组");
  swarm.state = "paused";
  writeSwarm(swarm);
  appendSwarmEvent(swarm.swarm_id, { type: "SWARM_PAUSED", summary: args.member ? `paused ${args.member}` : "paused all members" });
  return jsonResult(`网页会话组已暂停：${swarm.name}`, { paused: true, swarm: publicSwarm(readSwarm(swarm.swarm_id)) });
}

async function bridgeSwarmRun(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组只能由 MCP 控制面运行", { started: false }, true);
  let swarm;
  try { swarm = await syncSwarm(resolveSwarm(args.name || args.label)); } catch (error) { return jsonResult(String(error), { started: false }, true); }
  if (swarm.state === "paused") return jsonResult("网页会话组中存在异常成员，已暂停；请先修复原标签页后明确恢复", { started: false, swarm: publicSwarm(swarm) }, true);
  if (swarm.members.some(member => ["waiting_for_login", "preparing", "partial"].includes(member.state))) {
    return jsonResult("网页会话组尚未全部连接；请完成登录或目标选择后恢复", { started: false, swarm: publicSwarm(swarm) }, true);
  }
  const goal = String(args.goal || args.answer || "").trim();
  const selected = swarm.members.filter(member => ["ready", "awaiting_goal", "connected"].includes(member.state));
  if (!selected.length) return jsonResult("没有可运行的网页会话", { started: false, swarm: publicSwarm(swarm) }, true);
  const results = await Promise.all(selected.map(async member => {
    if (goal) {
      const goalResult = await swarmWorkerCall(swarm, member, "bridge_goal_create", { answer: goal }, 2 * 60 * 1000);
      if (goalResult?.isError) return { member, ok: false, state: "goal_failed", result: goalResult };
    } else if (member.link?.goal_status !== "attached") {
      return { member, ok: false, state: "goal_required" };
    }
    const runResult = await swarmWorkerCall(swarm, member, "bridge_run", { wait: args.wait === true }, args.wait === true ? 30 * 60 * 1000 : 2 * 60 * 1000);
    return { member, ok: !runResult?.isError, state: runResult?.structuredContent?.state || "running", result: runResult };
  }));
  for (const entry of results) {
    if (entry.ok) entry.member.state = entry.state === "paused" ? "paused" : "running";
    else await pauseSwarmMember(swarm, entry.member, entry.state, resultText(entry.result) || "网页会话运行失败");
  }
  swarm.state = swarmAggregateState(swarm);
  writeSwarm(swarm);
  appendSwarmEvent(swarm.swarm_id, { type: "SWARM_RUN", summary: `run requested for ${selected.length} members` });
  if (args.wait === true) await syncSwarm(swarm);
  return jsonResult(`网页会话组已启动：${swarm.name}`, {
    started: results.some(entry => entry.ok),
    members_started: results.filter(entry => entry.ok).length,
    members_failed: results.filter(entry => !entry.ok).length,
    swarm: publicSwarm(readSwarm(swarm.swarm_id)),
  }, results.every(entry => !entry.ok));
}

async function bridgeSwarmStop(args = {}) {
  if (IS_ROUTE_WORKER || !routeWorkerPool) return jsonResult("网页会话组只能由 MCP 控制面停止", { stopped: false }, true);
  let swarm;
  try { swarm = resolveSwarm(args.name || args.label); } catch (error) { return jsonResult(String(error), { stopped: false }, true); }
  for (const member of swarm.members || []) {
    try { await swarmWorkerCall(swarm, member, "browser_watchdog_stop", { name: member.watchdog_name }, 60 * 1000); } catch {}
    try { await swarmWorkerCall(swarm, member, "bridge_disconnect", {}, 2 * 60 * 1000); } catch {}
    member.state = "stopped";
  }
  swarm.state = "stopped";
  swarm.stop_reason = args.reason || "用户停止网页会话组";
  writeSwarm(swarm);
  appendSwarmEvent(swarm.swarm_id, { type: "SWARM_STOPPED", summary: swarm.stop_reason });
  return jsonResult(`网页会话组已停止：${swarm.name}`, { stopped: true, swarm: publicSwarm(readSwarm(swarm.swarm_id)) });
}

async function bridgeGoalCreate(args = {}) {
  if (!activeBridgeLink) return jsonResult("还没有建立网页端连接，无法创建目标", { goal_attached: false, state: "idle" }, true);
  if (activeBridgeLink.state === "waiting_for_login" || activeBridgeLink.state === "disconnected") {
    return jsonResult("网页端尚未准备好，完成登录并恢复连接后再创建目标", publicBridgeLink({ goal_attached: false, requires_login: true }), true);
  }
  const answer = args.answer ?? args.response ?? args.message ?? args.goal;
  let compiled;
  try {
    compiled = compileUserGoal(answer);
  } catch (error) {
    return jsonResult(String(error), publicBridgeLink({ goal_attached: false, requires_goal: true }), true);
  }
  const goal = compiled.goal;
  brainState = newBrainState();
  brainState.goal = goal;
  brainState.goal_source = compiled.source;
  brainState.goal_title = compiled.title;
  brainState.goal_compiled_at = compiled.compiled_at;
  brainState.goal_success_criteria = compiled.success_criteria;
  brainState.mode = activeBridgeLink.config?.mode || brainState.mode;
  brainState.continuous = brainState.mode === "continuous";
  brainState.maxRounds = brainState.continuous ? null : activeBridgeLink.config?.rounds ?? brainState.maxRounds;
  brainState.startedAt = compiled.compiled_at;
  activeBridgeLink.goal = goal;
  activeBridgeLink.goal_ir = compiled;
  activeBridgeLink.config = {
    ...(activeBridgeLink.config || {}),
    goal,
    goal_source: compiled.source,
  };
  activeRelayEngine?.setGoal?.(goal);

  // Bounded/continuous Brain-Hand links use a real Codex App Server worker.
  // Set its native Goal as soon as it exists; one-shot links stay lightweight
  // and will sync only if a worker is already bound or later starts.
  let nativeGoal = null;
  const route = readRoute(activeBridgeLink.route_id);
  const requiresWorker = activeBridgeLink.config?.mode !== "one_shot";
  if (requiresWorker && !route.codex_thread_id) {
    const started = await codexThreadStart({
      route_id: activeBridgeLink.route_id,
      cwd: args.cwd || process.cwd(),
      executor_provider: args.executor_provider,
      executor_model: args.executor_model,
      executor_profile: args.executor_profile,
    });
    if (started.isError) {
      nativeGoal = {
        synced: false,
        state: "pending",
        code: started.structuredContent?.code || "CODEX_WORKER_START_FAILED",
        reason: resultText(started) || "Codex worker could not be started; native Goal will be retried",
      };
    }
  }
  const currentRoute = readRoute(activeBridgeLink.route_id);
  if (currentRoute.codex_thread_id) {
    nativeGoal = await syncCodexNativeGoal({
      routeId: activeBridgeLink.route_id,
      objective: goal,
    });
  }
  activeBridgeLink.native_goal = nativeGoal || {
    synced: false,
    state: "pending",
    code: "CODEX_WORKER_NOT_STARTED",
    reason: "one-shot link does not start a Codex worker; native Goal sync will happen if a worker is started",
  };
  activeBridgeLink.state = activeBridgeLink.config.manual ? "ready" : "connected";
  persistActiveSession();
  syncActiveRoute({ status: activeBridgeLink.state });
  appendRouteEvent(activeBridgeLink.route_id, {
    type: "GOAL_ATTACHED",
    summary: compiled.title,
    data: {
      source: compiled.source,
      success_criteria: compiled.success_criteria,
      native_goal_synced: Boolean(activeBridgeLink.native_goal?.synced),
    },
  });
  const nativeMessage = activeBridgeLink.native_goal?.synced
    ? "，并已同步到 Codex 原生 Goal"
    : "；Codex 原生 Goal 将在 Worker 启动后重试同步";
  return jsonResult(`已创建并挂载目标：${compiled.title}${nativeMessage}`, publicBridgeLink({
    goal_attached: true,
    goal,
    goal_title: compiled.title,
    goal_source: compiled.source,
    goal_ir: compiled,
    native_goal: activeBridgeLink.native_goal,
    requires_goal: false,
  }));
}

async function verifyBridgeDestination() {
  if (!activeBridgeLink || !activeSession?.target_id) {
    const error = new Error("网页端连接还没有绑定可验证的标签页");
    error.code = "DESTINATION_NOT_BOUND";
    throw error;
  }
  const providerId = activeBridgeLink.provider_id || (activeBridgeLink.provider === "DeepSeek Web" ? "deepseek" : "chatgpt");
  const provider = getBrainProvider(providerId);
  const targets = await listTargets(activeBridgeLink.port);
  const page = targets.find(item => item.type === "page" && item.id === activeSession.target_id);
  if (!page) {
    const error = new Error("目标标签页已关闭或浏览器连接已断开");
    error.code = "BROWSER_TARGET_DISCONNECTED";
    throw error;
  }
  if (!providerMatchesUrl(provider, page.url)) {
    const error = new Error(`目标标签页已切换到非 ${provider.display_name} 页面`);
    error.code = "DESTINATION_PROVIDER_MISMATCH";
    throw error;
  }
  await ensureConnected(activeBridgeLink.port, activeSession, provider);
  const current = await currentConversationData(provider);
  const expected = activeBridgeLink.conversation;
  const conversationMismatch = expected && (
    !current.is_conversation
    || (expected.url && expected.url !== current.url)
    || (!expected.url && expected.title && expected.title !== current.title)
  );
  if (conversationMismatch) {
    const error = new Error(`目标对话发生变化：原为“${expected.title || expected.url}”，当前为“${current.title || current.url}”`);
    error.code = "DESTINATION_CONVERSATION_MISMATCH";
    error.expected = expected;
    error.actual = current;
    throw error;
  }
  if (!expected && current.is_conversation) {
    activeBridgeLink.conversation = { title: current.title || "当前对话", url: current.url || "" };
  }
  return { provider, page, current };
}

async function bridgeSend(args = {}) {
  if (!activeBridgeLink) return jsonResult("还没有建立网页端连接", { sent: false, state: "idle" }, true);
  if (!activeBridgeLink.goal && !activeBridgeLink.config?.goal && !brainState.goal) {
    return jsonResult("连接已建立，请先回答“你希望 Codex 完成什么？”，再发送网页消息", publicBridgeLink({ sent: false, requires_goal: true }), true);
  }
  if (activeBridgeLink.config?.direction === "web_to_codex") {
    return jsonResult("当前连接方向是网页端 → Codex，请使用接收操作；未向网页端发送内容", publicBridgeLink({ sent: false, direction: "web_to_codex" }), true);
  }
  const prompt = String(args.message ?? args.prompt ?? "").trim();
  if (!prompt) return jsonResult("请提供要发送给网页端的内容", publicBridgeLink({ sent: false }), true);
  try {
    const result = await activeRelayEngine.send({
      content: prompt,
      provider: activeBridgeLink.provider_id,
      conversationId: selectedConversation?.id,
      conversationTitle: selectedConversation?.title,
      turnIndex: activeBridgeLink.round || 0,
    });
    if (!result.sent) {
      const reason = result.reason || "连接未处于可发送状态";
      const paused = result.state === "paused" || activeRelayEngine?.status?.().state === "paused";
      return jsonResult(
        paused ? `网页端消息未发送，连接已暂停：${reason}` : reason,
        publicBridgeLink({ sent: false, reason, state: paused ? "paused" : activeBridgeLink.state, requires_resume: paused }),
        true,
      );
    }
    const reply = result.result?.reply || "";
    const envelope = createMessageEnvelope({
      origin: activeBridgeLink.provider_id === "deepseek" ? "web_deepseek" : "web_chatgpt",
      provider: activeBridgeLink.provider_id,
      conversationId: selectedConversation?.id,
      conversationTitle: selectedConversation?.title,
      relayId: activeBridgeLink.route_id,
      turnIndex: activeBridgeLink.round || 0,
      content: reply,
    });
    return jsonResult(reply, publicBridgeLink({ sent: true, reply, message: envelope, state: activeBridgeLink.state }));
  } catch (error) {
    const code = error.code || "BRIDGE_SEND_FAILED";
    await pauseActiveBridge(String(error), code);
    return jsonResult(`网页端发送失败，连接已暂停：${String(error)}`, publicBridgeLink({
      sent: false,
      state: "paused",
      reason: String(error),
      requires_resume: true,
      failure: activeBridgeLink.failure,
      expected_conversation: error.expected || activeBridgeLink.conversation,
      actual_conversation: error.actual || null,
    }), true);
  }
}

async function bridgeReceive() {
  if (!activeBridgeLink) return jsonResult("还没有建立网页端连接", { received: false, state: "idle" }, true);
  if (!activeBridgeLink.goal && !activeBridgeLink.config?.goal && !brainState.goal) {
    return jsonResult("连接已建立，请先回答“你希望 Codex 完成什么？”，再读取网页消息", publicBridgeLink({ received: false, requires_goal: true }), true);
  }
  const relayState = activeRelayEngine?.status?.().state;
  if (activeBridgeLink.state === "paused" || relayState === "paused") {
    const reason = activeBridgeLink.failure?.reason || activeRelayEngine?.status?.().last_stop || "网页桥接已暂停";
    return jsonResult(`网页桥接已暂停，未读取网页消息：${reason}`, publicBridgeLink({
      received: false,
      state: "paused",
      reason,
      requires_resume: true,
    }), true);
  }
  try {
    const result = await activeRelayEngine.receive({
      provider: activeBridgeLink.provider_id,
      conversationId: selectedConversation?.id,
      conversationTitle: selectedConversation?.title,
      sourceMessageId: selectedConversation?.url,
      turnIndex: activeBridgeLink.round || 0,
    });
    if (!result.received) {
      if (result.state === "paused") {
        return jsonResult(`网页桥接已暂停，未读取网页消息：${result.reason || "relay is paused"}`, publicBridgeLink({
          received: false,
          state: "paused",
          reason: result.reason || "relay is paused",
          requires_resume: true,
        }), true);
      }
      return jsonResult("网页端暂无新消息", publicBridgeLink({ received: false, new_message: false }));
    }
    return jsonResult(result.envelope.content, publicBridgeLink({ received: true, new_message: true, message: result.envelope }));
  } catch (error) {
    await pauseActiveBridge(String(error), error.code || "BRIDGE_RECEIVE_FAILED");
    return jsonResult(`读取网页消息失败，连接已暂停：${String(error)}`, publicBridgeLink({
      received: false,
      state: "paused",
      reason: String(error),
      requires_resume: true,
      failure: activeBridgeLink.failure,
    }), true);
  }
}

async function bridgeRun(args = {}) {
  if (!activeBridgeLink) return jsonResult("还没有建立网页端连接", { started: false, state: "idle" }, true);
  const relayState = activeRelayEngine?.status?.().state;
  if (activeBridgeLink.state === "paused" || relayState === "paused") {
    const reason = activeBridgeLink.failure?.reason || activeRelayEngine?.status?.().last_stop || "网页桥接已暂停";
    return jsonResult(`网页桥接已暂停，未启动搬运：${reason}`, publicBridgeLink({
      started: false,
      state: "paused",
      reason,
      requires_resume: true,
    }), true);
  }
  const config = activeBridgeLink.config || normalizeRelayConfig(args);
  const goal = String(args.goal || config.goal || "").trim();
  if (!goal) {
    return jsonResult(
      "网页端已连接，请先回答 Codex 的目标问题；插件会用你的回答创建本次 Brain-Hand 目标",
      publicBridgeLink({ started: false, requires_goal: true }),
      true,
    );
  }
  if (activeBridgeRun?.state === "running") {
    return jsonResult("网页端循环已经在后台运行，请使用网页端连接状态查看进度", publicBridgeLink({ started: false, already_running: true }));
  }
  const route = readRoute(activeBridgeLink.route_id);
  if (!route.codex_thread_id) {
    const started = await codexThreadStart({
      route_id: activeBridgeLink.route_id,
      cwd: args.cwd || process.cwd(),
      executor_provider: args.executor_provider,
      executor_model: args.executor_model,
      executor_profile: args.executor_profile,
    });
    if (started.isError) return started;
  }
  const nativeGoal = await syncCodexNativeGoal({
    routeId: activeBridgeLink.route_id,
    objective: goal,
  });
  activeBridgeLink.native_goal = nativeGoal;
  activeBridgeLink.state = "running";
  const runRecord = {
    state: "running",
    status: "running",
    round: activeBridgeLink.round || 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    result: null,
  };
  activeBridgeRun = runRecord;
  const operation = activeRelayEngine.run({
    goal,
    context: args.context,
    constraints: args.constraints,
    cwd: args.cwd,
    executor_provider: args.executor_provider,
    executor_model: args.executor_model,
    executor_profile: args.executor_profile,
    safety_limit: args.safety_limit,
  }).then(result => {
    runRecord.result = result;
    runRecord.status = result.status || result.state || "completed";
    runRecord.state = result.state || (runRecord.status === "completed" ? "completed" : "paused");
    runRecord.round = result.round ?? activeBridgeLink?.round ?? runRecord.round;
    runRecord.finished_at = new Date().toISOString();
    if (activeBridgeLink) activeBridgeLink.state = runRecord.state;
    return result;
  }).catch(async error => {
    runRecord.state = "paused";
    runRecord.status = "failed";
    runRecord.error = String(error);
    runRecord.finished_at = new Date().toISOString();
    if (activeBridgeLink) await pauseActiveBridge(String(error), error.code || "BRIDGE_RUN_FAILED");
    return { started: true, status: "blocked", state: "paused", reason: String(error) };
  });
  runRecord.promise = operation;
  if (args.wait === true) {
    const result = await operation;
    return jsonResult(result.status ? `网页端循环状态：${result.status}` : "网页端连接已准备好", publicBridgeLink({
      started: Boolean(result.started),
      result,
      native_goal: nativeGoal,
      state: activeBridgeLink.state,
    }), false);
  }
  return jsonResult("网页端循环已在后台启动；可继续使用 Codex，并通过连接状态查看进度", publicBridgeLink({
    started: true,
    background: true,
    native_goal: nativeGoal,
    state: activeBridgeLink.state,
  }), false);
}

async function bridgePause() {
  if (!activeBridgeLink || !activeRelayEngine) return jsonResult("还没有建立网页端连接", { paused: false, state: "idle" }, true);
  const state = await activeRelayEngine.pause("user pause");
  activeBridgeLink.state = "paused";
  return jsonResult("网页端连接已暂停", publicBridgeLink({ paused: true, state: state.state }));
}

async function bridgeDisconnect() {
  if (!activeBridgeLink) return jsonResult("还没有建立网页端连接", { disconnected: false, state: "idle" }, true);
  if (activeRelayEngine) await activeRelayEngine.stop("user disconnect");
  closeSocket();
  activeBridgeLink.state = "disconnected";
  return jsonResult("网页端连接已断开", publicBridgeLink({ disconnected: true, state: "disconnected" }));
}

async function bridgeExternalPanel(args = {}) {
  const requestedPort = Number(args.port || process.env.CODEX_BRIDGE_PANEL_PORT || 17841);
  const port = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535 ? requestedPort : 17841;
  if (activePanel) return jsonResult(`面板已打开：${activePanel.url}`, {
    opened: true,
    url: activePanel.url,
    panel_id: activePanel.panelId,
    codex_conversation_label: activePanel.label,
  });
  const token = crypto.randomBytes(24).toString("hex");
  const label = String(args.label || "当前 Codex 对话").trim().slice(0, 100) || "当前 Codex 对话";
  try {
    activePanel = await createPanelServer({
      port,
      token,
      label,
      open: args.open !== false,
      callTool: (name, toolArgs) => callToolDirect(name, toolArgs),
    });
  } catch (error) {
    activePanel = null;
    return jsonResult(`无法启动本地面板：${String(error)}`, { opened: false }, true);
  }
  return jsonResult(`面板已打开：${activePanel.url}`, {
    opened: true,
    url: activePanel.url,
    panel_id: activePanel.panelId,
    codex_conversation_label: activePanel.label,
  });
}

async function bridgePanel(args = {}) {
  if (args.external === true) return bridgeExternalPanel(args);
  return nativeUiResult("已在当前 Codex 对话中打开网页桥接面板。", {
    native_ui: true,
    conversation_scope: "current_codex_conversation",
    message: "这是当前 Codex 对话内的桥接面板；它不会与其他 Codex 对话共享可见的 UI 状态。",
    bridge: publicBridgeLink(),
  });
}

async function browserHealth(args = {}) {
  const port = portOf(args);
  const provider = brainProviderOf(args);
  try {
    ensureActiveSession(args);
    await ensureConnected(port, activeSession, provider);
    const health = await evaluate(getWebLLMAdapter(provider.id).selectorHealthScript());
    return jsonResult(`${provider.display_name} adapter health: ${health?.ok ? "ok" : "degraded"}`, {
      healthy: Boolean(health?.ok),
      brain_provider: provider.id,
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
      strategies: health?.strategies || [],
    }, !health?.ok);
  } catch (error) {
    return jsonResult(String(error), { healthy: false, session_id: activeSessionId, port }, true);
  }
}

async function openBrainBrowser(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  const explicitTarget = Boolean(args.target_id || args.targetId || args.target_title || args.targetTitle || args.target_url || args.targetUrl);
  let page;
  try {
    page = await findBrainTarget(port, activeSession, provider, args);
  } catch (error) {
    return jsonResult(String(error), { opened: false, port }, true);
  }
  if (!page && !activeSession?.target_id && !explicitTarget) {
    try {
      page = await createBrainTarget(port, provider, activeSession);
    } catch {}
  }
  if (!page) {
    return jsonResult(
      activeSession?.target_id
        ? "the bound browser tab is unavailable; no replacement tab was opened automatically"
        : `open ${provider.start_url} manually in the remote-debug browser`,
      { opened: false, port, target_preserved: Boolean(activeSession?.target_id), recovery_required: Boolean(activeSession?.target_id) },
      true,
    );
  }
  try {
    await connectToTarget(page);
    try { await cdpRaw("Page.bringToFront", {}); } catch {}
    if (!providerMatchesUrl(provider, page.url)) await cdpRaw("Page.navigate", { url: provider.start_url });
    try {
      const current = await currentConversationData(provider);
      selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    } catch {}
    activeSession.target_id = page.id || null;
    activeSession.brain_provider = provider.id;
    activeSession.target_url = page.url || provider.start_url;
    persistActiveSession();
    return jsonResult(`${provider.display_name} page is ready; sign in manually if needed`, {
      opened: true,
      url: target?.url || provider.start_url,
      brain_provider: provider.id,
      port,
      session_id: activeSessionId,
      browser_target_id: activeSession.target_id,
    });
  } catch (error) {
    return jsonResult(String(error), { opened: false, port, session_id: activeSessionId }, true);
  }
}

async function pageSnapshot(provider = brainProviderOf()) {
  const adapter = getWebLLMAdapter(provider.id);
  const profile = adapter.profile;
  const assistantSelectors = JSON.stringify(profile.assistant_selectors);
  const generatingTerms = JSON.stringify(profile.generating_terms);
  const loginTerms = JSON.stringify(profile.login_terms);
  return evaluate(`(() => {
    const assistantSelectors = ${assistantSelectors};
    const assistantNodes = assistantSelectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    let nodes = [...new Set(assistantNodes)];
    if (!nodes.length) nodes = [...document.querySelectorAll('article')];
    // Scrape only the recent assistant messages. Scanning and returning the
    // whole transcript on every 800ms poll made long conversations freeze the
    // renderer and also made an old last message look like a new reply.
    nodes = nodes.slice(-60);
    const assistant_messages = nodes.map((node, index) => {
      const explicitId = node.getAttribute('data-message-id')
        || node.getAttribute('data-testid')
        || node.id
        || '';
      const id = explicitId || ('assistant-' + index);
      const raw = (node.innerText || '').trim();
      const text = raw.length > 20000 ? raw.slice(0, 12000) + '\\n...[message clipped]\\n' + raw.slice(-7000) : raw;
      return { id, text };
    }).filter(message => message.text);
    const messages = assistant_messages.map(message => message.text);
    const buttons = [...document.querySelectorAll('button')];
    const generatingTerms = ${generatingTerms};
    const buttonText = buttons.map(button => ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase()).join(' ');
    const streamingMarkup = Boolean(document.querySelector('.streaming-animation, [class*="streaming"]'));
    const generating = streamingMarkup || generatingTerms.some(term => buttonText.includes(term.toLowerCase()));
    const bodyText = (document.body?.innerText || '').slice(0, 3000);
    const lowerBody = bodyText.toLowerCase();
    const loginRequired = location.pathname.includes('/auth/') || ${loginTerms}.some(term => lowerBody.includes(term.toLowerCase()));
    return { url: location.href, loginRequired, messages, assistant_messages, last: messages.at(-1) || '', generating };
  })()`);
}

async function refreshBoundBrowserTab(port, provider, timeoutMs = 15000) {
  const boundTargetId = activeSession?.target_id;
  if (!boundTargetId) {
    const error = new Error("cannot refresh a browser tab before a target is bound");
    error.code = "DESTINATION_NOT_BOUND";
    throw error;
  }

  // Reconnect only to the persisted target. The recovery path is deliberately
  // not allowed to call createBrainTarget or fall through to another page.
  await ensureConnected(port, activeSession, provider, { allowCreate: false });
  if (target?.id !== boundTargetId) {
    const error = new Error("the bound browser tab changed; no replacement tab was opened");
    error.code = "BROWSER_TARGET_CHANGED";
    throw error;
  }

  try {
    await cdpRaw("Page.reload", { ignoreCache: false });
  } catch (firstError) {
    // A reload can close the current DevTools socket while leaving the same
    // page alive. Reattach to that same target once, never to a new one.
    await ensureConnected(port, activeSession, provider, { allowCreate: false });
    try {
      await cdpRaw("Page.reload", { ignoreCache: false });
    } catch {
      throw firstError;
    }
  }

  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 20000);
  let lastHealth = null;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const pages = await listTargets(port);
    const page = pages.find(item => item.type === "page" && item.id === boundTargetId);
    if (!page) {
      const error = new Error("the bound browser tab was closed during same-tab refresh");
      error.code = "BROWSER_TARGET_DISCONNECTED";
      throw error;
    }
    if (!providerMatchesUrl(provider, page.url)) {
      const error = new Error(`the bound browser tab changed to a non-${provider.display_name} page`);
      error.code = "DESTINATION_PROVIDER_MISMATCH";
      throw error;
    }
    try {
      await ensureConnected(port, activeSession, provider, { allowCreate: false });
      lastHealth = await evaluate(getWebLLMAdapter(provider.id).selectorHealthScript());
      if (lastHealth?.ok) return { refreshed: true, healthy: true, strategies: lastHealth.strategies || [] };
    } catch (error) {
      lastHealth = { ok: false, reason: String(error) };
    }
  }
  const error = new Error("same-tab refresh completed, but the web composer is still unavailable");
  error.code = "WEB_UI_CHANGED";
  error.health = lastHealth;
  throw error;
}

async function askBrain(args = {}) {
  const rawPrompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!rawPrompt) return jsonResult("prompt is required", { sent: false }, true);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  const adapter = getWebLLMAdapter(provider.id);
  const profile = adapter.profile;
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || 120000), 10000), 300000);
  const promptInfo = compactWebPrompt(rawPrompt, { limit: WEB_PROMPT_MAX_CHARS });
  const prompt = promptInfo.text;
  let deliveryKey = "";
  let submitted = false;
  try {
    ensureActiveSession(args);
    if (activeBridgeLink?.route_id === activeRouteId) await verifyBridgeDestination();
    // A bound route may only use its exact target. In particular, a timed-out
    // send must not silently create a replacement tab on the next attempt.
    await ensureConnected(port, activeSession, provider, { allowCreate: false });
    deliveryKey = crypto.createHash("sha256").update(JSON.stringify({
      provider: provider.id,
      target_id: activeSession?.target_id || target?.id || "",
      conversation_url: selectedConversation?.url || activeSession?.conversation?.url || target?.url || "",
      prompt,
    })).digest("hex");
    const previousDelivery = readWebDelivery(deliveryKey);
    if (previousDelivery) {
      return jsonResult("duplicate web send blocked; the previous delivery is still completed or unresolved", {
        sent: false,
        retry_allowed: false,
        delivery_state: previousDelivery.state,
        delivery_id: deliveryKey,
        target_preserved: true,
      }, true);
    }
    durableWebDelivery(deliveryKey, {
      state: "prepared",
      provider: provider.id,
      target_id: activeSession?.target_id || target?.id || null,
      conversation_url: selectedConversation?.url || activeSession?.conversation?.url || target?.url || null,
      prompt_length: prompt.length,
      original_prompt_length: rawPrompt.length,
    });
    let before = await pageSnapshot(provider);
    if (before.loginRequired) {
      removeWebDelivery(deliveryKey);
      return jsonResult(`${provider.display_name} requires manual sign-in in the dedicated browser`, { sent: false, url: before.url, brain_provider: provider.id }, true);
    }
    const inputSelectorsLiteral = JSON.stringify(profile.input_selectors);
    const preparePrompt = () => evaluate(`(() => {
      const selectors = ${inputSelectorsLiteral};
      const sendSelectors = ${JSON.stringify(profile.send_selectors)};
      const sendTerms = ${JSON.stringify(profile.send_terms)};
      const input = selectors.map(selector => document.querySelector(selector)).find(Boolean);
      const buttons = [...document.querySelectorAll('button')];
      const send = sendSelectors.map(selector => document.querySelector(selector)).find(Boolean)
        || buttons.find(button => {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase();
          return sendTerms.some(term => label.includes(term.toLowerCase()));
        });
      if (!input) return { ok: false, reason: 'input-not-found' };
      input.focus();
      return { ok: true, send_available_before_insert: Boolean(send), tag: input.tagName, contenteditable: input.isContentEditable };
    })()`);
    let prepared = await preparePrompt();
    let refreshedSameTab = false;
    if (!prepared?.ok && ["input-not-found", "send-button-not-found"].includes(prepared?.reason)) {
      try {
        await refreshBoundBrowserTab(port, provider, Math.min(timeoutMs, 15000));
        refreshedSameTab = true;
        before = await pageSnapshot(provider);
        if (before.loginRequired) {
          removeWebDelivery(deliveryKey);
          return jsonResult(`${provider.display_name} requires manual sign-in after same-tab refresh`, {
            sent: false,
            refreshed_same_tab: true,
            replacement_opened: false,
            url: before.url,
            brain_provider: provider.id,
          }, true);
        }
        prepared = await preparePrompt();
      } catch (error) {
        removeWebDelivery(deliveryKey);
        return jsonResult(`web composer unavailable after refreshing the same tab: ${String(error)}` , {
          sent: false,
          reason: error.code || "same_tab_refresh_failed",
          refreshed_same_tab: true,
          replacement_opened: false,
          browser_target_id: activeSession?.target_id || null,
        }, true);
      }
    }
    if (!prepared?.ok) {
      removeWebDelivery(deliveryKey);
      return jsonResult(
      refreshedSameTab
        ? `could not submit prompt after refreshing the same tab: ${prepared?.reason || "web UI changed"}; no new tab was opened`
        : prepared?.reason === "send-button-not-found"
          ? `could not submit prompt: send button not found; the bound tab was preserved and no new tab was opened`
        : `could not prepare prompt: ${prepared?.reason || "unknown"}`,
      { sent: false, reason: prepared?.reason || "unknown", target_preserved: prepared?.target_preserved !== false, replacement_opened: false, refreshed_same_tab: refreshedSameTab, browser_target_id: activeSession?.target_id || null },
      true,
      );
    }

    await cdpRaw("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpRaw("Input.insertText", { text: prompt });
    await new Promise(resolve => setTimeout(resolve, 250));
    const inserted = await evaluate(`(() => {
      const selectors = ${inputSelectorsLiteral};
      const expected = ${JSON.stringify(prompt)};
      const input = selectors.map(selector => document.querySelector(selector)).find(Boolean);
      if (!input) return { ok: false, reason: 'input-not-found-after-insert' };
      const actual = String(input.isContentEditable ? (input.innerText || '') : (input.value || '')).replace(/\\r\\n/g, '\\n');
      return {
        ok: actual === expected,
        actual_length: actual.length,
        expected_length: expected.length,
        reason: actual === expected ? '' : 'composer-value-mismatch',
      };
    })()`);
    if (!inserted?.ok) {
      removeWebDelivery(deliveryKey);
      return jsonResult(`web composer did not accept the complete prompt; nothing was sent`, {
        sent: false,
        reason: inserted?.reason || "composer-value-mismatch",
        actual_length: inserted?.actual_length || 0,
        expected_length: inserted?.expected_length || prompt.length,
        prompt_truncated: promptInfo.truncated,
        replacement_opened: false,
        target_preserved: true,
      }, true);
    }
    const sendSelectorsLiteral = JSON.stringify(profile.send_selectors);
    const sendTermsLiteral = JSON.stringify(profile.send_terms);
    const generatingTermsLiteral = JSON.stringify(profile.generating_terms);
    const sent = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const selectors = ${sendSelectorsLiteral};
      const sendTerms = ${sendTermsLiteral};
      const generatingTerms = ${generatingTermsLiteral};
      const send = selectors.map(selector => document.querySelector(selector)).find(Boolean)
        || buttons.find(button => {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase();
          return sendTerms.some(term => label.includes(term.toLowerCase())) && !generatingTerms.some(term => label.includes(term.toLowerCase()));
        });
      if (!send) return { ok: false, reason: 'send-button-not-found' };
      if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'send-button-disabled' };
      send.click();
      return { ok: true };
    })()`);
    if (!sent?.ok) {
      removeWebDelivery(deliveryKey);
      return jsonResult(`could not submit prompt: ${sent?.reason || "unknown"}`, { sent: false, target_preserved: true }, true);
    }
    submitted = true;
    durableWebDelivery(deliveryKey, {
      state: "submitted",
    });

    const deadline = Date.now() + timeoutMs;
    const tracker = createReplyTracker(before, {
      stablePollsRequired: WEB_REPLY_STABLE_POLLS,
      minStableMs: WEB_REPLY_MIN_STABLE_MS,
    });
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const state = await pageSnapshot(provider);
      if (state.loginRequired) {
        durableWebDelivery(deliveryKey, { state: "unknown" });
        return jsonResult(`${provider.display_name} requested sign-in after submission; the message may still be generating`, {
          sent: true,
          delivery_state: "unknown",
          retry_allowed: false,
          reply_available: false,
          brain_provider: provider.id,
          target_preserved: true,
        }, true);
      }
      const replyState = observeReply(tracker, state, Date.now());
      if (replyState.done) {
        const replyText = replyState.candidate.text;
        durableWebDelivery(deliveryKey, {
          state: "completed",
          reply_length: replyText.length,
        });
        // Conversation metadata is useful but must not turn an already
        // completed delivery back into an unknown delivery when the sidebar
        // is temporarily unavailable.
        try {
          const current = await currentConversationData(provider);
          selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : selectedConversation;
          persistActiveSession();
        } catch {}
        return jsonResult(replyText, {
          sent: true,
          reply: replyText,
          url: state.url,
          brain_provider: provider.id,
          session_id: activeSessionId,
          browser_target_id: activeSession?.target_id || null,
          delivery_state: "completed",
          delivery_id: deliveryKey,
          prompt_truncated: promptInfo.truncated,
          original_prompt_length: promptInfo.originalLength,
        });
      }
    }
    persistActiveSession();
    durableWebDelivery(deliveryKey, {
      state: "unknown",
    });
    return jsonResult(`timed out waiting for a stable ${provider.display_name} reply; the message may still be generating and was not resent`, {
      sent: true,
      delivery_state: "unknown",
      retry_allowed: false,
      reply_available: false,
      brain_provider: provider.id,
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
      delivery_id: deliveryKey,
      prompt_truncated: promptInfo.truncated,
      original_prompt_length: promptInfo.originalLength,
    }, true);
  } catch (error) {
    if (deliveryKey) {
      if (submitted) {
        durableWebDelivery(deliveryKey, {
          state: "unknown",
          error: String(error),
        });
      } else {
        removeWebDelivery(deliveryKey);
      }
    }
    return jsonResult(String(error), {
      sent: submitted,
      delivery_state: submitted ? "unknown" : "not_submitted",
      retry_allowed: false,
      port,
      session_id: activeSessionId,
      target_preserved: true,
    }, true);
  }
}

const TOOLS = [
  {
    name: "bridge_toolkit_list",
    description: "List the installable capabilities in the Codex Bridge toolkit series. The umbrella plugin stays one install; each toolkit is an independent feature group.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_toolkit_status",
    description: "Show toolkit health, human-readable links between Codex conversations and web conversations, and active browser watchdogs without exposing routing IDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_link_list",
    description: "List all persisted Codex ↔ web links by human-readable names. Separate links can use separate sessions and browser tabs; technical IDs remain internal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_watchdog_scan",
    description: "Read-only health check for a visible Edge/Chrome web-LLM tab. Reports login, loading, composer, generation, selector, and responsiveness state. It never sends, retries, switches tabs, or opens a replacement tab.",
    inputSchema: { type: "object", properties: {
      provider: { type: "string", enum: listBrainProviders().map(provider => provider.id), default: DEFAULT_BRAIN_PROVIDER },
      port: { type: "integer", minimum: 1, maximum: 65535, default: DEFAULT_PORT },
      tab: { type: "string", description: "Visible tab title or exact URL. Required when more than one provider tab is present." },
      target_title: { type: "string", description: "Exact visible tab title." },
      target_url: { type: "string", description: "Exact visible tab URL." },
      timeout_ms: { type: "integer", minimum: 500, maximum: 15000, default: 3500 },
    } },
  },
  {
    name: "browser_watchdog_start",
    description: "Start a periodic, read-only browser watchdog in the current MCP process. It monitors one existing visible tab and reports degradation; it never auto-sends, auto-switches, or bypasses login. Stop it explicitly when no longer needed.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable watchdog name, such as 论文 ChatGPT 标签页." },
      provider: { type: "string", enum: listBrainProviders().map(provider => provider.id), default: DEFAULT_BRAIN_PROVIDER },
      port: { type: "integer", minimum: 1, maximum: 65535, default: DEFAULT_PORT },
      tab: { type: "string", description: "Visible tab title or exact URL." },
      target_title: { type: "string" },
      target_url: { type: "string" },
      route_id: { type: "string", description: "Optional bridge route to receive durable health-alert events." },
      interval_ms: { type: "integer", minimum: 5000, maximum: 600000, default: 15000 },
      timeout_ms: { type: "integer", minimum: 500, maximum: 15000, default: 3500 },
      generation_timeout_ms: { type: "integer", minimum: 15000, maximum: 1800000, default: 180000 },
    } },
  },
  {
    name: "browser_watchdog_status",
    description: "Read the current browser watchdog checks and last visible health result.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "browser_watchdog_stop",
    description: "Stop a named browser watchdog without changing the browser or bridge session.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "github_workspace_status",
    description: "Inspect the current local Git/GitHub workspace: repository root, branch, upstream, remotes, ahead/behind counts, and changed files. This toolkit is read-only and never pulls, pushes, commits, or contacts GitHub.",
    inputSchema: { type: "object", properties: { cwd: { type: "string", description: "Optional local workspace path. Defaults to the current Codex workspace." } } },
  },
  {
    name: "github_workspace_bind",
    description: "Bind the current local Git/GitHub workspace summary to an existing route. This only stores branch/remotes/change context; it never pulls, pushes, commits, or contacts GitHub.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      cwd: { type: "string", description: "Optional local workspace path. Defaults to the current Codex workspace." },
    }, required: ["route_id"] },
  },
  {
    name: "bridge_host_status",
    description: "Report MCP host compatibility and safety boundaries. DevSpace is only generic stdio MCP compatible until a dedicated adapter is implemented; ChatGPT Web is a bridged web peer, not a local MCP host.",
    inputSchema: { type: "object", properties: {
      host: { type: "string", enum: ["generic", "codex", "opencode", "devspace", "chatgpt_web"], default: "generic", description: "Host to inspect. Defaults to the generic stdio MCP contract." },
    } },
  },
  {
    name: "artifact_workspace_status",
    description: "Read-only scan of the selected local workspace for Word, PowerPoint, PDF, Markdown, text, CSV, and spreadsheet files. Returns filenames and metadata only; it does not read document bodies, upload files, or log in to Notion.",
    inputSchema: { type: "object", properties: {
      cwd: { type: "string", description: "Optional local workspace path. Defaults to the current Codex workspace." },
      max_depth: { type: "integer", minimum: 0, maximum: 8, default: 4 },
      max_files: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    } },
  },
  {
    name: "artifact_workspace_read",
    description: "Read bounded UTF-8 content only from explicitly selected files inside a local workspace. Markdown, text, and CSV are supported; Word/PPT/PDF return metadata-only capability notices. Never reads the whole workspace, uploads files, or logs in to Notion.",
    inputSchema: { type: "object", properties: {
      cwd: { type: "string", description: "Optional local workspace path. Defaults to the current Codex workspace." },
      files: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "Relative paths returned by artifact_workspace_status. Explicit selection is required." },
      max_total_chars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
      max_file_chars: { type: "integer", minimum: 500, maximum: 20000, default: 8000 },
    }, required: ["files"] },
  },
  {
    name: "bridge_swarm_list",
    description: "List persisted multi-web-session groups by human-readable names and aggregate safety status. Internal worker, route, session, target, and port identifiers are never returned.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_swarm_create",
    description: "Create and connect a multi-web-session group. Each member gets its own MCP worker, exact visible browser target, and read-only browser watchdog while sharing one local Git workspace context. It never silently changes tabs or resends prompts.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable group name, such as 论文多模型组." },
      cwd: { type: "string", description: "Local Git workspace to bind read-only to every member. Defaults to the current workspace." },
      members: { type: "array", minItems: 1, maxItems: 32, description: "One object per already-open visible web conversation. Run bridge_discover first and use human browser/window/tab/conversation choices.", items: { type: "object", properties: {
        label: { type: "string" },
        provider: { type: "string", enum: listBrainProviders().map(provider => provider.id), default: DEFAULT_BRAIN_PROVIDER },
        browser: { type: "string" },
        window: { type: "string" },
        tab: { type: "string" },
        conversation: { type: "string" },
        mode: { type: "string", enum: ["one_shot", "bounded", "continuous"], default: "one_shot" },
        rounds: { type: "integer", minimum: 0, maximum: 50, default: 1 },
        direction: { type: "string", enum: ["codex_to_web", "web_to_codex"], default: "codex_to_web" },
        auto_launch: { type: "boolean", default: false, description: "Swarm defaults to false to avoid opening replacement browser sessions; enable only explicitly." },
        executor_provider: executorProviderSchema(),
        executor_model: executorModelSchema(),
        executor_profile: executorProfileSchema(),
        executor_endpoint: executorEndpointSchema(),
        executor_agent: executorAgentSchema(),
      } } },
      interval_ms: { type: "integer", minimum: 5000, maximum: 600000, default: 15000 },
      generation_timeout_ms: { type: "integer", minimum: 15000, maximum: 1800000, default: 180000 },
    }, required: ["name", "members"] },
  },
  {
    name: "bridge_swarm_status",
    description: "Refresh and aggregate the health of one multi-web-session group, including member states, independent watchdog alerts, runs, duplicate targets, and the shared local workspace. A failure leaves the group paused.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Human-readable group name. Omit to list all groups." } } },
  },
  {
    name: "bridge_swarm_resume",
    description: "Explicitly retry the original browser target for a paused or waiting swarm member after the user fixes the visible page. It never selects a replacement tab or resends a prompt.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable group name." },
      member: { type: "string", description: "Optional human-readable member label; omit to retry every member." },
    }, required: ["name"] },
  },
  {
    name: "bridge_swarm_run",
    description: "Run the same explicit goal across every ready member in parallel. A goal is compiled separately in each worker; any member failure pauses that member and the whole group without retrying or switching destinations.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable group name." },
      goal: { type: "string", description: "The goal to attach to each member. Omit only when every member already has an attached goal." },
      wait: { type: "boolean", default: false, description: "Wait for all selected member runs to finish. Defaults to background start." },
    }, required: ["name"] },
  },
  {
    name: "bridge_swarm_pause",
    description: "Pause one member or the whole group. Pausing never closes tabs, switches destinations, or resends messages.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable group name." },
      member: { type: "string", description: "Optional human-readable member label; omit to pause every member." },
      reason: { type: "string" },
    }, required: ["name"] },
  },
  {
    name: "bridge_swarm_stop",
    description: "Stop a group explicitly, stopping its watchdogs and disconnecting its member links. It never deletes files or opens replacement browser sessions.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Human-readable group name." },
      reason: { type: "string" },
    }, required: ["name"] },
  },
  {
    name: "bridge_discover",
    description: "Scan for visible Edge/Chrome browser instances, automatically start the dedicated persistent Edge profile when none is connectable, and present browsers, windows, and tabs in human terms. Technical IDs remain internal.",
    inputSchema: { type: "object", properties: {
      provider: { type: "string", enum: listBrainProviders().map(provider => provider.id), default: DEFAULT_BRAIN_PROVIDER, description: "Web brain to open automatically when no debuggable browser is available." },
      auto_launch: { type: "boolean", default: true, description: "Automatically start the dedicated persistent Edge profile when no debuggable browser is available." },
    } },
  },
  {
    name: "bridge_connect",
    description: "Connect this Codex conversation to a selected visible web AI. If no debuggable browser is available, automatically start the dedicated persistent Edge profile. Choose by provider, browser name, tab number/title, conversation title, and relay mode; the bridge manages internal routing IDs.",
    inputSchema: { type: "object", properties: {
      provider: { type: "string", enum: listBrainProviders().map(provider => provider.id), default: DEFAULT_BRAIN_PROVIDER },
      browser: { type: "string", description: "Human browser choice such as Edge 浏览器 1. Omit when only one browser is available." },
      window: { type: "string", description: "Human window choice such as 窗口 1 or 1. Required when multiple windows make the tab number ambiguous." },
      tab: { type: "string", description: "Human tab number, exact title, or exact URL." },
      conversation: { type: "string", description: "Visible conversation title, ID, or provider URL." },
      mode: { type: "string", enum: ["one_shot", "bounded", "continuous"], default: "one_shot" },
      rounds: { type: "integer", minimum: 0, maximum: 50, default: 1, description: "0 means manual linked mode; 1-50 means bounded relay rounds." },
      direction: { type: "string", enum: ["codex_to_web", "web_to_codex"], default: "codex_to_web" },
      goal: { type: "string", description: "Internal compiled bridge goal created from the user's answer after connection. The user should not enter a goal in the panel." },
      goal_source: { type: "string", enum: ["plugin_question", "codex_conversation", "explicit"], default: "plugin_question", description: "The goal source. By default the bridge asks the user for a goal after connection and compiles the answer." },
      auto_launch: { type: "boolean", default: true, description: "Automatically start the dedicated persistent Edge profile when no debuggable browser is available." },
      cwd: { type: "string", description: "Optional local workspace to bind as read-only GitHub context for this link." },
      resume: { type: "boolean", description: "Re-check the current pending browser connection after the user finishes login or page preparation." },
      executor_provider: executorProviderSchema({ includeDefault: true }),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
    } },
  },
  {
    name: "bridge_status",
    description: "Show the current user-facing web connection, browser, tab, conversation, mode, and relay state without exposing technical IDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_goal_create",
    description: "After a web connection is ready, turn the user's answer to the built-in goal question into a bounded bridge goal and attach it to the current bridge task. The panel never creates a goal.",
    inputSchema: { type: "object", properties: {
      answer: { type: "string", description: "The user's answer describing what Codex should accomplish." },
    }, required: ["answer"] },
  },
  {
    name: "bridge_focus",
    description: "Bring a selected human-named browser tab to the foreground for visual confirmation without exposing DevTools IDs.",
    inputSchema: { type: "object", properties: {
      browser: { type: "string" },
      window: { type: "string" },
      tab: { type: "string" },
    } },
  },
  {
    name: "bridge_send",
    description: "Send one explicit Codex message through the active web connection and return the visible web reply with peer-origin metadata.",
    inputSchema: { type: "object", properties: {
      message: { type: "string" },
      timeout_ms: { type: "integer", default: 120000 },
    }, required: ["message"] },
  },
  {
    name: "bridge_receive",
    description: "Read one new visible assistant message from the active web connection without sending a prompt. Deduplicates repeated web replies and marks the peer origin.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_run",
    description: "Start the active web connection as a background bounded or continuous Brain-Hand relay using the current Codex conversation goal. The bridge supplies internal route/session IDs and stops on mismatch, blocker, repetition, evidence failure, or the configured safety limit. Use wait=true only when a caller explicitly needs the legacy synchronous result.",
    inputSchema: { type: "object", properties: {
      goal: { type: "string", description: "Internal compiled bridge goal created by bridge_goal_create; do not invent a separate UI goal." },
      context: { type: "string" },
      constraints: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      timeout_ms: { type: "integer", default: 120000 },
      safety_limit: { type: "integer", minimum: 1, maximum: 10000, default: 1000 },
      wait: { type: "boolean", default: false, description: "Wait for the whole run only when explicitly requested; the default is background execution so Codex remains usable." },
    } },
  },
  {
    name: "bridge_pause",
    description: "Pause the active web connection without switching its browser tab or conversation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_disconnect",
    description: "Disconnect the active web connection and stop its relay state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_panel",
    description: "Render a native in-conversation status panel showing only the Codex ↔ web connection state and selected destination. Connection, goal creation, and relay mode are controlled through the Codex conversation. Set external=true only when the current host does not render MCP Apps UI.",
    inputSchema: { type: "object", properties: {
      port: { type: "integer", minimum: 1024, maximum: 65535, default: 17841 },
      open: { type: "boolean", default: true },
      label: { type: "string", description: "Human-readable label for the Codex conversation that opened this panel, for example '论文研究'." },
      external: { type: "boolean", default: false, description: "Use the legacy loopback browser panel only when native MCP Apps UI is unavailable." },
    } },
    _meta: { ui: { resourceUri: MCP_UI_RESOURCE_URI, prefersBorder: true }, "openai/toolInvocation/invoking": "正在打开 Codex 内置连接状态面板…", "openai/toolInvocation/invoked": "Codex 内置连接状态面板已打开" },
  },
  {
    name: "bridge_route_create",
    description: "Create a lightweight Control Plane route that maps one local executor host session to one selected web brain session/tab. Codex uses App Server; OpenCode uses its documented local HTTP server.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string", description: "Stable route key, for example pokemon-rl." },
      name: { type: "string" },
      brain_provider: brainProviderSchema({ includeDefault: true }),
      executor_provider: executorProviderSchema({ includeDefault: true }),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      codex_thread_id: { type: "string", description: "Optional Codex Thread ID for Control Plane metadata." },
      session_id: { type: "string", description: "Web brain bridge session to bind to this route." },
    }, required: ["route_id"] },
  },
  {
    name: "bridge_route_list",
    description: "List compact route metadata for the Control Plane without loading full task histories.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge_route_status",
    description: "Inspect one route's compact state, queue counters, latest plan/report/review, and recent protocol events.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" } }, required: ["route_id"] },
  },
  {
    name: "bridge_route_bind",
    description: "Bind or update a route's local executor session, web brain provider/session, target tab, and conversation metadata.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      name: { type: "string" },
      brain_provider: brainProviderSchema(),
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      codex_thread_id: { type: "string" },
      session_id: { type: "string" },
      target_id: { type: "string" },
      conversation_id: { type: "string" },
    }, required: ["route_id"] },
  },
  {
    name: "bridge_route_pause",
    description: "Pause a route. Queued route actions will wait until the route is resumed; an already-running browser request is not forcibly interrupted.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" }, reason: { type: "string" } }, required: ["route_id"] },
  },
  {
    name: "bridge_route_resume",
    description: "Resume a paused route so its queued actions may continue.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" }, reason: { type: "string" } }, required: ["route_id"] },
  },
  {
    name: "bridge_route_event",
    description: "Append a structured protocol event to a route queue. Supported event types include TASK, RESULT, EVIDENCE, QUESTION, REVIEW, BLOCKED, and COMPLETED.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      type: { type: "string" },
      event_type: { type: "string" },
      summary: { type: "string" },
      message: { type: "string" },
      data: { type: "object" },
    }, required: ["route_id"] },
  },
  {
    name: "codex_adapter_status",
    description: "Inspect the selected local executor host adapter and route worker state without starting a process.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" } } },
  },
  {
    name: "codex_thread_start",
    description: "Start or resume the selected executor host session for a route. Codex uses App Server; OpenCode uses an existing opencode serve endpoint.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      codex_thread_id: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      base_instructions: { type: "string" },
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      approval_policy: { type: "string" },
    }, required: ["route_id"] },
  },
  {
    name: "codex_thread_turn",
    description: "Send an explicit task to the local executor session bound to a route and return its completed result when available.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      codex_thread_id: { type: "string" },
      text: { type: "string" },
      task: { type: "string" },
      prompt: { type: "string" },
      input: { type: "array" },
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      effort: { type: "string" },
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      timeout_ms: { type: "integer", default: 120000 },
    }, required: ["route_id"] },
  },
  {
    name: "codex_thread_read",
    description: "Read the metadata/messages for the selected executor session bound to a route.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      codex_thread_id: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
    }, required: ["route_id"] },
  },
  {
    name: "codex_source_thread_read",
    description: "Read another explicit codex://threads/<id> conversation as bounded, read-only source content. It never binds that conversation as the current worker or sends a message to it.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      thread_url: { type: "string", description: "Explicit codex://threads/<thread-id> URL from the source Codex conversation." },
      max_chars: { type: "integer", default: 12000, maximum: 24000 },
    }, required: ["route_id", "thread_url"] },
  },
  {
    name: "chatgpt_browser_session_create",
    description: "Create a persistent bridge session that owns one selected web brain browser tab. Use a different session_id for each independent task; do not delete sessions through the bridge.",
    inputSchema: { type: "object", properties: {
      session_id: { type: "string", description: "Stable task/session key, for example project-alpha or project-beta." },
      brain_provider: brainProviderSchema({ includeDefault: true }),
      name: { type: "string", description: "Human-readable session name." },
    }, required: ["session_id"] },
  },
  {
    name: "chatgpt_browser_session_list",
    description: "List persistent bridge sessions, their selected provider, browser target, conversation, and brain-hand progress.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chatgpt_browser_launch",
    description: "Launch a dedicated Chrome/Edge profile with remote debugging and open the selected web brain. The user must sign in manually. Never use this to bypass login or CAPTCHA.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT }, profile_dir: { type: "string" } } },
  },
  {
    name: "chatgpt_browser_status",
    description: "Read-only check of the remote-debug browser and visible tabs.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_health",
    description: "Check the selected web brain adapter's selector strategies and report UI health without sending a prompt.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_open",
    description: "Open or connect to a visible selected web brain page in the remote-debug browser. Use before asking if no page is connected.",
    inputSchema: { type: "object", properties: {
      port: { type: "integer", default: DEFAULT_PORT },
      target_id: { type: "string", description: "Optional exact DevTools target ID from browser status. Binds this session to that visible tab instead of auto-selecting another page." },
      target_title: { type: "string", description: "Optional exact visible tab title. Use only when it is unique; target_id is more stable." },
      target_url: { type: "string", description: "Optional exact visible tab URL. Use only when it is unique; target_id is more stable." },
    } },
  },
  {
    name: "chatgpt_browser_list_conversations",
    description: "List visible selected web brain conversations with titles, IDs, URLs, and the current selection. Use query to filter titles.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_select_conversation",
    description: "Select a visible selected web brain conversation by exact or unique title, conversation ID, or provider URL. Refuses to switch during an active brain-hand task unless force=true.",
    inputSchema: { type: "object", properties: {
      title: { type: "string" },
      conversation_id: { type: "string" },
      id: { type: "string" },
      url: { type: "string" },
      force: { type: "boolean", default: false },
      timeout_ms: { type: "integer", default: 15000 },
      port: { type: "integer", default: DEFAULT_PORT },
    } },
  },
  {
    name: "chatgpt_browser_current_conversation",
    description: "Return the currently selected web brain conversation title, ID, and URL.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_ask",
    description: "Send an explicit user-approved prompt through the selected visible web brain page and return the visible assistant reply. Do not forward passwords, API keys, private credentials, or unapproved secrets.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, port: { type: "integer", default: DEFAULT_PORT }, timeout_ms: { type: "integer", default: 120000 } }, required: ["prompt"] },
  },
  {
    name: "brain_plan",
    description: "Start or reset the brain-hand mode. Ask the selected web brain to produce one concrete, verifiable next task for the configured executor. The web model plans; the executor works in the connected workspace.",
    inputSchema: { type: "object", properties: {
      goal: { type: "string" },
      context: { type: "string" },
      constraints: { type: "array", items: { type: "string" } },
      max_rounds: { type: "integer", default: DEFAULT_MAX_ROUNDS, maximum: HARD_MAX_ROUNDS },
      continuous: { type: "boolean", default: false },
      port: { type: "integer", default: DEFAULT_PORT },
      timeout_ms: { type: "integer", default: 120000 },
    }, required: ["goal"] },
  },
  {
    name: "executor_report",
    description: "Send the executor's result to the selected planning brain. Send concise final outcomes, changed files, tests, blockers, and evidence; never send hidden chain-of-thought, passwords, or tokens.",
    inputSchema: { type: "object", properties: {
      report: { type: "string" },
      result: { type: "string" },
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      tests: { type: "array", items: { type: "string" } },
      blockers: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      status: { type: "string" },
      round: { type: "integer" },
      port: { type: "integer", default: DEFAULT_PORT },
      timeout_ms: { type: "integer", default: 120000 },
    } },
  },
  {
    name: "brain_review",
    description: "Ask the selected planning brain to review the latest executor report and classify it as continue, completed, blocked, or repeated, with the next task and acceptance criteria.",
    inputSchema: { type: "object", properties: {
      report: { type: "string" },
      result: { type: "string" },
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      tests: { type: "array", items: { type: "string" } },
      blockers: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      port: { type: "integer", default: DEFAULT_PORT },
      timeout_ms: { type: "integer", default: 120000 },
    } },
  },
  {
    name: "continue_task",
    description: "Advance brain-hand mode by one round. It can accept a new Luna execution report, review it, detect completion/blocking/repetition, enforce the configured round limit, and return the next executable task.",
    inputSchema: { type: "object", properties: {
      executor_report: { type: "string" },
      report: { type: "string" },
      result: { type: "string" },
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      tests: { type: "array", items: { type: "string" } },
      blockers: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      max_rounds: { type: "integer", maximum: HARD_MAX_ROUNDS },
      continuous: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      port: { type: "integer", default: DEFAULT_PORT },
      timeout_ms: { type: "integer", default: 120000 },
    } },
  },
  {
    name: "run_round",
    description: "Run one complete brain-to-Codex runtime round: use the current plan or ask the selected web brain for one, execute it with the route's Codex worker, compile a bounded report, ask for review, persist protocol events, and apply stop policy.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      goal: { type: "string" },
      context: { type: "string" },
      constraints: { type: "array", items: { type: "string" } },
      max_rounds: { type: "integer", maximum: HARD_MAX_ROUNDS },
      continuous: { type: "boolean", default: false },
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      effort: { type: "string" },
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      timeout_ms: { type: "integer", default: 120000 },
      safety_limit: { type: "integer", minimum: 1, maximum: 10000, default: 1000 },
      port: { type: "integer", default: DEFAULT_PORT },
    }, required: ["route_id"] },
  },
  {
    name: "run_until_stop",
    description: "Run bounded brain-to-Codex rounds until completed, blocked, repeated, or max_rounds. Codex approval or interaction requests are never auto-approved; they stop the run with an explicit blocker.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      goal: { type: "string" },
      context: { type: "string" },
      constraints: { type: "array", items: { type: "string" } },
      max_rounds: { type: "integer", default: DEFAULT_MAX_ROUNDS, maximum: HARD_MAX_ROUNDS },
      continuous: { type: "boolean", default: false },
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      effort: { type: "string" },
      executor_endpoint: executorEndpointSchema(),
      executor_agent: executorAgentSchema(),
      timeout_ms: { type: "integer", default: 120000 },
      safety_limit: { type: "integer", minimum: 1, maximum: 10000, default: 1000 },
      port: { type: "integer", default: DEFAULT_PORT },
    }, required: ["route_id"] },
  },
  {
    name: "brain_status",
    description: "Read the current in-memory brain-hand mode state, including round, plan, report, review, and stop-related information.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_reset",
    description: "Reset the in-memory brain-hand mode state without changing browser data or deleting files.",
    inputSchema: { type: "object", properties: {} },
  },
];

TOOLS.push({
  name: "brain_provider_list",
  description: "List the installed visible-web planning brain providers and their supported conversation URL profiles.",
  inputSchema: { type: "object", properties: {} },
});

TOOLS.push({
  name: "executor_provider_list",
  description: "List the available Codex executor providers, models, and local profile mappings. API keys remain outside the bridge.",
  inputSchema: { type: "object", properties: {} },
});

const BRAIN_TOOL_ALIASES = [
  ["brain_browser_session_create", "chatgpt_browser_session_create"],
  ["brain_browser_session_list", "chatgpt_browser_session_list"],
  ["brain_browser_launch", "chatgpt_browser_launch"],
  ["brain_browser_status", "chatgpt_browser_status"],
  ["brain_browser_health", "chatgpt_browser_health"],
  ["brain_browser_open", "chatgpt_browser_open"],
  ["brain_browser_list_conversations", "chatgpt_browser_list_conversations"],
  ["brain_browser_select_conversation", "chatgpt_browser_select_conversation"],
  ["brain_browser_current_conversation", "chatgpt_browser_current_conversation"],
  ["brain_browser_ask", "chatgpt_browser_ask"],
];
for (const [alias, sourceName] of BRAIN_TOOL_ALIASES) {
  const source = TOOLS.find(tool => tool.name === sourceName);
  if (!source) continue;
  TOOLS.push({
    ...source,
    name: alias,
    description: source.description.replace(/ChatGPT Web/g, "the selected web brain"),
    inputSchema: JSON.parse(JSON.stringify(source.inputSchema)),
  });
}

const PUBLIC_BRIDGE_TOOLS = new Set(["bridge_discover", "bridge_connect", "bridge_goal_create", "bridge_status", "bridge_focus", "bridge_send", "bridge_receive", "bridge_run", "bridge_pause", "bridge_disconnect", "bridge_panel"]);
const CONTEXT_ONLY_TOOLS = new Set(["bridge_host_status", "artifact_workspace_status", "artifact_workspace_read", "bridge_swarm_list", "bridge_swarm_create", "bridge_swarm_status", "bridge_swarm_resume", "bridge_swarm_run", "bridge_swarm_pause", "bridge_swarm_stop"]);
for (const tool of TOOLS) {
  if (!tool.inputSchema?.properties || PUBLIC_BRIDGE_TOOLS.has(tool.name) || CONTEXT_ONLY_TOOLS.has(tool.name) || tool.name === "brain_provider_list" || tool.name === "executor_provider_list" || tool.name.includes("session_") || tool.name.startsWith("bridge_route_")) continue;
  tool.inputSchema.properties.session_id = {
    type: "string",
    default: DEFAULT_SESSION_ID,
    description: "Persistent bridge session key. Reuse one key when related tool calls should share a selected web brain browser tab; use a distinct key for independent work.",
  };
  tool.inputSchema.properties.brain_provider = {
    ...brainProviderSchema(),
  };
}

const ROUTED_TOOLS = new Set([
  "chatgpt_browser_status",
  "chatgpt_browser_health",
  "chatgpt_browser_open",
  "chatgpt_browser_list_conversations",
  "chatgpt_browser_select_conversation",
  "chatgpt_browser_current_conversation",
  "chatgpt_browser_ask",
  "brain_browser_status",
  "brain_browser_health",
  "brain_browser_open",
  "brain_browser_list_conversations",
  "brain_browser_select_conversation",
  "brain_browser_current_conversation",
  "brain_browser_ask",
  "brain_plan",
  "executor_report",
  "brain_review",
  "continue_task",
  "run_round",
  "run_until_stop",
  "brain_status",
  "brain_reset",
  "codex_thread_start",
  "codex_thread_turn",
  "codex_thread_read",
  "codex_source_thread_read",
]);

// Public bridge state must not live in the parent MCP process. A separate
// worker owns the CDP socket, selected tab, relay engine, and Codex adapter for
// one host Codex conversation. This is what makes independent A/B/C tasks
// safe to run in parallel instead of merely persisting several route files.
const ROUTE_WORKER_TOOLS = new Set([
  "bridge_connect",
  "bridge_goal_create",
  "bridge_status",
  "bridge_send",
  "bridge_receive",
  "bridge_run",
  "bridge_pause",
  "bridge_disconnect",
  "bridge_panel",
]);

async function callToolDirect(name, args) {
  if (name === "bridge_toolkit_list") return toolkitCatalog();
  if (name === "bridge_toolkit_status") return toolkitStatus();
  if (name === "bridge_link_list") return jsonResult("当前 Codex ↔ 网页端连接", { links: bridgeLinkList() });
  if (name === "browser_watchdog_scan") return browserWatchdogScan(args);
  if (name === "browser_watchdog_start") return browserWatchdogStart(args);
  if (name === "browser_watchdog_status") return browserWatchdogStatus(args);
  if (name === "browser_watchdog_stop") return browserWatchdogStop(args);
  if (name === "github_workspace_status") return githubWorkspaceStatus(args);
  if (name === "github_workspace_bind") return bindGithubWorkspace(args);
  if (name === "bridge_host_status") return bridgeHostStatus(args);
  if (name === "artifact_workspace_status") return artifactWorkspaceStatus(args);
  if (name === "artifact_workspace_read") return artifactWorkspaceRead(args);
  if (name === "bridge_swarm_list" || name === "bridge_swarm_status") return bridgeSwarmStatus(args);
  if (name === "bridge_swarm_create") return bridgeSwarmCreate(args);
  if (name === "bridge_swarm_resume") return bridgeSwarmResume(args);
  if (name === "bridge_swarm_run") return bridgeSwarmRun(args);
  if (name === "bridge_swarm_pause") return bridgeSwarmPause(args);
  if (name === "bridge_swarm_stop") return bridgeSwarmStop(args);
  if (name === "bridge_discover") return bridgeDiscover(args);
  if (name === "bridge_connect") return bridgeConnect(args);
  if (name === "bridge_goal_create") return bridgeGoalCreate(args);
  if (name === "bridge_status") return bridgeStatus(args);
  if (name === "bridge_worker_runtime_status") return bridgeWorkerRuntimeStatus();
  if (name === "bridge_focus") return bridgeFocus(args);
  if (name === "bridge_send") return bridgeSend(args);
  if (name === "bridge_receive") return bridgeReceive(args);
  if (name === "bridge_run") return bridgeRun(args);
  if (name === "bridge_pause") return bridgePause(args);
  if (name === "bridge_disconnect") return bridgeDisconnect(args);
  if (name === "bridge_panel") return bridgePanel(args);
  if (name === "brain_provider_list") return brainProviderList();
  if (name === "executor_provider_list") return executorProviderList();
  if (name === "bridge_route_create") return routeCreate(args);
  if (name === "bridge_route_list") return routeList();
  if (name === "bridge_route_status") return routeStatus(args);
  if (name === "bridge_route_bind") return routeBind(args);
  if (name === "bridge_route_pause") return routePause(args);
  if (name === "bridge_route_resume") return routeResume(args);
  if (name === "bridge_route_event") return routeEvent(args);
  if (name === "codex_adapter_status") return codexAdapterStatus(args);
  if (name === "codex_thread_start") return codexThreadStart(args);
  if (name === "codex_thread_turn") return codexThreadTurn(args);
  if (name === "codex_thread_read") return codexThreadRead(args);
  if (name === "codex_source_thread_read") return codexSourceThreadRead(args);
  if (name === "chatgpt_browser_session_create" || name === "brain_browser_session_create") return createSession(args);
  if (name === "chatgpt_browser_session_list" || name === "brain_browser_session_list") return listSessions();
  if (name === "chatgpt_browser_launch" || name === "brain_browser_launch") return jsonResult("dedicated browser launched; sign in manually", launchBrowser(args));
  if (name === "chatgpt_browser_status" || name === "brain_browser_status") return browserStatus(args);
  if (name === "chatgpt_browser_health" || name === "brain_browser_health") return browserHealth(args);
  if (name === "chatgpt_browser_open" || name === "brain_browser_open") return openBrainBrowser(args);
  if (name === "chatgpt_browser_list_conversations" || name === "brain_browser_list_conversations") return listConversations(args);
  if (name === "chatgpt_browser_select_conversation" || name === "brain_browser_select_conversation") return selectConversation(args);
  if (name === "chatgpt_browser_current_conversation" || name === "brain_browser_current_conversation") return currentConversation(args);
  if (name === "chatgpt_browser_ask" || name === "brain_browser_ask") return askBrain(args);
  if (name === "brain_plan") return brainPlan(args);
  if (name === "executor_report") return executorReport(args);
  if (name === "brain_review") return brainReview(args);
  if (name === "continue_task") return continueTask(args);
  if (name === "run_round") return runRound(args);
  if (name === "run_until_stop") return runUntilStop(args);
  if (name === "brain_status") return brainStatus(args);
  if (name === "brain_reset") return brainReset(args);
  return jsonResult(`unknown tool: ${name}`, undefined, true);
}

async function callTool(name, args) {
  if (!IS_ROUTE_WORKER && routeWorkerPool && ROUTE_WORKER_TOOLS.has(name)) {
    try {
      return await routeWorkerPool.call(name, args, { timeoutMs: args.wait === true ? 30 * 60 * 1000 : 10 * 60 * 1000 });
    } catch (error) {
      return jsonResult(String(error), { state: "worker_unavailable", parallel_execution: true }, true);
    }
  }
  if (!ROUTED_TOOLS.has(name)) return callToolDirect(name, args);
  let routeId;
  try { routeId = routeIdOf(args); }
  catch (error) { return jsonResult(String(error), { route_id: null }, true); }
  enqueueRouteEvent(routeId, { type: "ACTION_QUEUED", summary: name });
  try {
    return await enqueueRouteAction(routeId, name, () => callToolDirect(name, args), {
      allowPaused: name === "brain_reset",
    });
  } catch (error) {
    return jsonResult(String(error), { route_id: routeId, queued: false }, true);
  }
}

async function handle(message) {
  if (!message.id) return null;
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: { listChanged: false, read: true } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } };
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  if (message.method === "resources/list") return { jsonrpc: "2.0", id: message.id, result: { resources: [nativeUiResource()] } };
  if (message.method === "resources/read") {
    const uri = String(message.params?.uri || "");
    if (uri !== MCP_UI_RESOURCE_URI) {
      return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown resource: ${uri}` } };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: MCP_UI_RESOURCE_URI,
          mimeType: MCP_UI_RESOURCE_MIME,
          text: readNativeUiHtml(),
          _meta: { ui: { prefersBorder: true } },
        }],
      },
    };
  }
  if (message.method === "tools/call") {
    const params = message.params || {};
    const hostContext = hostCodexContextFromRequest(message);
    const argumentsWithContext = hostContext
      ? { ...(params.arguments || {}), __host_codex_context: hostContext }
      : (params.arguments || {});
    return { jsonrpc: "2.0", id: message.id, result: await callTool(params.name, argumentsWithContext) };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(error) } })}\n`);
  }
}
