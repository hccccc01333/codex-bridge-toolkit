#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
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
  updateRoute,
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
import { selectorHealthScript } from "../src/browser/selectors.mjs";
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
  executorProfileOf as codexProfileOf,
  getExecutorProvider,
  listExecutorProviders,
  normalizeCodexProfile,
  normalizeExecutorProvider,
} from "../src/adapters/executor.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";
import { createRuntimeRunner } from "../src/runtime/runner.mjs";
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
    description: "Select the Codex executor provider. ChatGPT Luna is the default; DeepSeek API exposes Pro and Flash models.",
  };
  if (includeDefault) schema.default = DEFAULT_EXECUTOR_PROVIDER;
  return schema;
}

function executorModelSchema() {
  return {
    type: "string",
    enum: [...new Set(listExecutorProviders().flatMap(provider => provider.models))],
    description: "Optional Codex executor model. Leave empty to use the selected provider's default; DeepSeek supports deepseek-v4-pro and deepseek-v4-flash.",
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
  return jsonResult("supported Codex executor providers", {
    default_provider: DEFAULT_EXECUTOR_PROVIDER,
    providers: listExecutorProviders(),
    note: "The bridge selects local Codex profiles; API keys remain managed by Codex configuration or environment.",
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
  executorModelOf(executorProviderId, executorModel || "");
  if (explicitRoute && (route.session_id !== sessionId
    || route.brain_provider !== providerId
    || route.executor_provider !== executorProviderId
    || route.executor_model !== executorModel
    || route.executor_profile !== (executorProfile || null))) {
    route = writeRoute({
      ...route,
      session_id: sessionId,
      brain_provider: providerId,
      executor_provider: executorProviderId,
      executor_model: executorModel,
      executor_profile: executorProfile || null,
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
  const route = newRouteRecord(id, {
    name: args.name,
    brain_provider: brainProvider,
    executor_provider: executorProvider,
    executor_model: executorModel,
    executor_profile: executorProfile || null,
    codex_thread_id: args.codex_thread_id ?? args.codexThreadId,
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
  route = writeRoute({
    ...route,
    name: args.name || route.name,
    brain_provider: brainProvider,
    executor_provider: executorProvider,
    executor_model: executorModel,
    executor_profile: executorProfile || null,
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

function codexAdapterForRoute(routeId, executorProviderId = undefined, executorModel = "", executorProfile = "") {
  const id = normalizeRouteId(routeId);
  const route = readRoute(id);
  const provider = getExecutorProvider(executorProviderId || route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
  const model = executorModelOf(provider, executorModel || route.executor_model);
  const profile = executorProfileFor({ executor_profile: executorProfile || route.executor_profile }, provider, model);
  const adapterKey = `${provider.id}:${model || "(config)"}:${profile || "(config)"}`;
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
    adapter.executor_key = adapterKey;
    adapter.executor_provider = provider.id;
    adapter.executor_model = model;
    adapter.executor_profile = profile || null;
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
  return jsonResult(`Codex Adapter status: ${id}`, {
    adapter: codexAdapterForRoute(id, provider.id, model, profile).status(),
    executor_provider: provider.id,
    executor_model: model,
    executor_profile: profile || null,
    route: routeSummary(route),
  });
}

async function codexThreadStart(args = {}) {
  let route = activateRoute(args);
  try {
    const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelFor({ ...args, executor_model: args.executor_model ?? args.executorModel ?? args.model ?? route.executor_model }, provider);
    const profile = executorProfileFor(args, provider, model);
    route = updateRoute(route.route_id, {
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? null,
    });
    const adapter = codexAdapterForRoute(route.route_id, provider.id, model, profile);
    const result = await adapter.startThread({
      thread_id: args.codex_thread_id || route.codex_thread_id || null,
      cwd: args.cwd || process.cwd(),
      model,
      baseInstructions: args.base_instructions,
      approvalPolicy: args.approval_policy,
    });
    const updated = updateRoute(route.route_id, {
      codex_thread_id: result.thread_id,
      status: "worker_ready",
      last_action: "codex_thread_start",
    });
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
      route: routeSummary(updated),
      adapter: adapter.status(),
    });
  } catch (error) {
    return jsonResult(String(error), { started: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
  }
}

async function codexThreadTurn(args = {}) {
  let route = activateRoute(args);
  const threadId = args.codex_thread_id || route.codex_thread_id;
  if (!threadId) return jsonResult("codex_thread_id is required; call codex_thread_start first", { sent: false }, true);
  try {
    const provider = executorProviderOf(args, route.executor_provider || DEFAULT_EXECUTOR_PROVIDER);
    const model = executorModelFor({ ...args, executor_model: args.executor_model ?? args.executorModel ?? args.model ?? route.executor_model }, provider);
    const profile = executorProfileFor(args, provider, model);
    route = updateRoute(route.route_id, {
      executor_provider: provider.id,
      executor_model: model,
      executor_profile: args.executor_profile ?? args.executorProfile ?? route.executor_profile ?? null,
    });
    const result = await codexAdapterForRoute(route.route_id, provider.id, model, profile).sendTask({
      thread_id: threadId,
      text: args.text || args.task || args.prompt,
      input: args.input,
      timeoutMs: args.timeout_ms,
      cwd: args.cwd,
      model,
      effort: args.effort,
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
    const result = await codexAdapterForRoute(route.route_id, provider.id, model, profile).readThread(threadId);
    return jsonResult(`Codex thread read: ${threadId}`, { read: true, thread_id: threadId, executor_provider: provider.id, executor_model: model, executor_profile: profile || null, result });
  } catch (error) {
    return jsonResult(String(error), { read: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
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

async function brainPlan(args = {}) {
  activateRoute(args);
  const goal = clip(args.goal);
  if (!goal.trim()) return jsonResult("goal is required", { planned: false }, true);
  brainState = newBrainState();
  brainState.goal = goal;
  brainState.constraints = stringList(args.constraints);
  brainState.maxRounds = maxRoundsOf(args.max_rounds);
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

async function createBrainTarget(port, provider = brainProviderOf()) {
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
}

async function findBrainTarget(port, session = activeSession, provider = brainProviderOf()) {
  const targets = await listTargets(port);
  const pages = targets.filter(item => item.type === "page");
  if (session?.target_id) {
    const stored = pages.find(item => item.id === session.target_id);
    if (stored && providerMatchesUrl(provider, stored.url)) return stored;
  }
  if (session?.conversation?.id) {
    const stored = pages.find(item => providerMatchesUrl(provider, item.url) && conversationIdFromUrl(item.url || "", provider.id) === session.conversation.id);
    if (stored) return stored;
  }
  const claimed = claimedTargetIds(session?.session_id || "");
  return pages.find(item => providerMatchesUrl(provider, item.url) && !claimed.has(item.id)) || null;
}

async function ensureConnected(port, session = activeSession, provider = brainProviderOf()) {
  if (socket && socket.readyState === WebSocket.OPEN && target && session?.target_id === target.id && providerMatchesUrl(provider, target.url)) return;
  let page = await findBrainTarget(port, session, provider) || await createBrainTarget(port, provider);
  if (!page) {
    throw new Error(`no browser page found. Launch a browser with remote debugging on port ${port}, then open ${provider.start_url}`);
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
  const linkSelectors = JSON.stringify(provider.conversation_link_selectors);
  const state = await evaluate(`(() => {
    const url = location.href;
    const selectors = ${linkSelectors};
    const links = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    const current = links.find(anchor => anchor.href.split('?')[0] === url.split('?')[0]);
    const rawTitle = (current?.getAttribute('aria-label') || current?.innerText || document.title || '').trim();
    const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
    return { title, url, is_conversation: Boolean(${JSON.stringify(provider.conversation_prefixes)}.some(prefix => location.pathname.toLowerCase().startsWith(prefix.toLowerCase()))) };
  })()`);
  return { ...state, id: conversationIdFromUrl(state?.url || "", provider.id) };
}

async function visibleConversations(query = "", provider = brainProviderOf()) {
  const queryLiteral = JSON.stringify(String(query || "").trim().toLowerCase());
  const conversations = await evaluate(`(() => {
    const query = ${queryLiteral};
    const seen = new Set();
    const selectors = ${JSON.stringify(provider.conversation_link_selectors)};
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
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
}

function defaultProfileDir() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexChatGPTBridge", "profile");
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
  child.unref();
  return { launched: true, executable, port, profile_dir: profileDir, url: provider.start_url, brain_provider: provider.id };
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

async function browserHealth(args = {}) {
  const port = portOf(args);
  const provider = brainProviderOf(args);
  try {
    ensureActiveSession(args);
    await ensureConnected(port, activeSession, provider);
    const health = await evaluate(selectorHealthScript(provider.id));
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
  let page;
  try {
    page = await findBrainTarget(port, activeSession, provider);
  } catch (error) {
    return jsonResult(String(error), { opened: false, port }, true);
  }
  if (!page) {
    try {
      page = await createBrainTarget(port, provider);
    } catch {}
  }
  if (!page) return jsonResult(`open ${provider.start_url} manually in the remote-debug browser`, { opened: false, port }, true);
  try {
    await connectToTarget(page);
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
  const assistantSelectors = JSON.stringify(provider.assistant_selectors);
  const generatingTerms = JSON.stringify(provider.generating_terms);
  const loginTerms = JSON.stringify(provider.login_terms);
  return evaluate(`(() => {
    const assistantSelectors = ${assistantSelectors};
    const assistantNodes = assistantSelectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    let messages = [...new Set(assistantNodes)].map(node => (node.innerText || '').trim()).filter(Boolean);
    if (!messages.length) {
      messages = [...document.querySelectorAll('article')].map(node => (node.innerText || '').trim()).filter(Boolean);
    }
    const buttons = [...document.querySelectorAll('button')];
    const generatingTerms = ${generatingTerms};
    const buttonText = buttons.map(button => ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase()).join(' ');
    const streamingMarkup = Boolean(document.querySelector('.streaming-animation, [class*="streaming"]'));
    const generating = streamingMarkup || generatingTerms.some(term => buttonText.includes(term.toLowerCase()));
    const bodyText = (document.body?.innerText || '').slice(0, 3000);
    const lowerBody = bodyText.toLowerCase();
    const loginRequired = location.pathname.includes('/auth/') || ${JSON.stringify(provider.login_terms)}.some(term => lowerBody.includes(term.toLowerCase()));
    return { url: location.href, loginRequired, messages, last: messages.at(-1) || '', generating };
  })()`);
}

async function askBrain(args = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return jsonResult("prompt is required", { sent: false }, true);
  const port = portOf(args);
  const provider = brainProviderOf(args);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || 120000), 10000), 300000);
  try {
    ensureActiveSession(args);
    await ensureConnected(port, activeSession, provider);
    const before = await pageSnapshot(provider);
    if (before.loginRequired) {
      return jsonResult(`${provider.display_name} requires manual sign-in in the dedicated browser`, { sent: false, url: before.url, brain_provider: provider.id }, true);
    }
    const promptLiteral = JSON.stringify(prompt);
    const inputSelectorsLiteral = JSON.stringify(provider.input_selectors);
    const prepared = await evaluate(`(() => {
      const value = ${promptLiteral};
      const selectors = ${inputSelectorsLiteral};
      const input = selectors.map(selector => document.querySelector(selector)).find(Boolean);
      if (!input) return { ok: false, reason: 'input-not-found' };
      input.focus();
      return { ok: true, tag: input.tagName, contenteditable: input.isContentEditable };
    })()`);
    if (!prepared?.ok) return jsonResult(`could not prepare prompt: ${prepared?.reason || "unknown"}`, { sent: false }, true);

    await cdpRaw("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpRaw("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpRaw("Input.insertText", { text: prompt });
    await new Promise(resolve => setTimeout(resolve, 250));
    const sendSelectorsLiteral = JSON.stringify(provider.send_selectors);
    const sendTermsLiteral = JSON.stringify(provider.send_terms);
    const generatingTermsLiteral = JSON.stringify(provider.generating_terms);
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
      send.click();
      return { ok: true };
    })()`);
    if (!sent?.ok) return jsonResult(`could not submit prompt: ${sent?.reason || "unknown"}`, { sent: false }, true);

    const deadline = Date.now() + timeoutMs;
    let previous = before.last;
    let stablePolls = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const state = await pageSnapshot(provider);
      if (state.loginRequired) return jsonResult(`${provider.display_name} requested sign-in after submission`, { sent: true, brain_provider: provider.id }, true);
      const changed = state.last && (state.last !== before.last || state.messages.length > before.messages.length);
      if (changed && state.last === previous) stablePolls += 1;
      else if (changed) { previous = state.last; stablePolls = 0; }
      if (changed && !state.generating && stablePolls >= 2) {
        const current = await currentConversationData(provider);
        selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : selectedConversation;
        persistActiveSession();
        return jsonResult(state.last, { sent: true, reply: state.last, url: state.url, brain_provider: provider.id, session_id: activeSessionId, browser_target_id: activeSession?.target_id || null });
      }
    }
    persistActiveSession();
    return jsonResult(`timed out waiting for a stable ${provider.display_name} reply`, { sent: true, last: previous, brain_provider: provider.id, session_id: activeSessionId }, true);
  } catch (error) {
    return jsonResult(String(error), { sent: false, port, session_id: activeSessionId }, true);
  }
}

const TOOLS = [
  {
    name: "bridge_route_create",
    description: "Create a lightweight Control Plane route that maps one executor thread to one selected web brain session/tab. The Codex Adapter can drive the bound thread through App Server.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string", description: "Stable route key, for example pokemon-rl." },
      name: { type: "string" },
      brain_provider: brainProviderSchema({ includeDefault: true }),
      executor_provider: executorProviderSchema({ includeDefault: true }),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
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
    description: "Bind or update a route's Codex thread, web brain provider/session, target tab, and conversation metadata.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      name: { type: "string" },
      brain_provider: brainProviderSchema(),
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
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
    description: "Inspect the Codex Adapter and route worker state without starting a Codex process.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" } } },
  },
  {
    name: "codex_thread_start",
    description: "Start or resume the Codex App Server worker for a route and bind its real thread id to the Control Plane.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      codex_thread_id: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      base_instructions: { type: "string" },
      approval_policy: { type: "string" },
    }, required: ["route_id"] },
  },
  {
    name: "codex_thread_turn",
    description: "Send an explicit task to the Codex worker bound to a route and return its completed turn when available.",
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
      timeout_ms: { type: "integer", default: 120000 },
    }, required: ["route_id"] },
  },
  {
    name: "codex_thread_read",
    description: "Read the metadata for the Codex thread bound to a route through the App Server protocol.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      codex_thread_id: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
    }, required: ["route_id"] },
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
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
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
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      effort: { type: "string" },
      timeout_ms: { type: "integer", default: 120000 },
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
      cwd: { type: "string" },
      model: { type: "string" },
      executor_provider: executorProviderSchema(),
      executor_model: executorModelSchema(),
      executor_profile: executorProfileSchema(),
      effort: { type: "string" },
      timeout_ms: { type: "integer", default: 120000 },
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

for (const tool of TOOLS) {
  if (!tool.inputSchema?.properties || tool.name === "brain_provider_list" || tool.name === "executor_provider_list" || tool.name.includes("session_") || tool.name.startsWith("bridge_route_")) continue;
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
]);

async function callToolDirect(name, args) {
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
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } };
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    const params = message.params || {};
    return { jsonrpc: "2.0", id: message.id, result: await callTool(params.name, params.arguments || {}) };
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
