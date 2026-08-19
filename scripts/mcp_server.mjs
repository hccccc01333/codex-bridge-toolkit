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
import { SELECTOR_STRATEGIES, selectorHealthScript } from "../src/browser/selectors.mjs";
import { createCodexAdapter } from "../src/adapters/codex.mjs";
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
const CHATGPT_URL = "https://chatgpt.com/";
const SERVER_NAME = "chatgpt-web-bridge";
const SERVER_VERSION = "0.1.0";
const DEFAULT_MAX_ROUNDS = STOP_DEFAULT_MAX_ROUNDS;
const HARD_MAX_ROUNDS = STOP_HARD_MAX_ROUNDS;
const DEFAULT_SESSION_ID = "default";
const SESSION_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexChatGPTBridge", "sessions");

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

function newSessionState(sessionId, name = "") {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    name: firstNonEmpty(name, sessionId),
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
  const session = newSessionState(id, args.name);
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
  if (explicitRoute && route.session_id !== sessionId) {
    route = writeRoute({ ...route, session_id: sessionId });
  }
  activeRouteId = id;
  activeRoute = route;
  activateSession({ ...args, session_id: sessionId });
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
  const route = newRouteRecord(id, {
    name: args.name,
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
  route = writeRoute({
    ...route,
    name: args.name || route.name,
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

function codexAdapterForRoute(routeId) {
  const id = normalizeRouteId(routeId);
  let adapter = codexAdapters.get(id);
  if (!adapter) {
    adapter = createCodexAdapter({
      cwd: process.cwd(),
      onNotification: message => {
        if (message.method === "turn/completed") {
          appendRouteEvent(id, {
            type: "CODEX_TURN_COMPLETED",
            summary: `Codex turn completed: ${message.params?.turn?.status || "unknown"}`,
          });
        }
      },
    });
    codexAdapters.set(id, adapter);
  }
  return adapter;
}

function codexAdapterStatus(args = {}) {
  const id = routeIdOf(args);
  const route = readRoute(id);
  return jsonResult(`Codex Adapter status: ${id}`, {
    adapter: codexAdapterForRoute(id).status(),
    route: routeSummary(route),
  });
}

async function codexThreadStart(args = {}) {
  const route = activateRoute(args);
  const adapter = codexAdapterForRoute(route.route_id);
  try {
    const result = await adapter.startThread({
      thread_id: args.codex_thread_id || route.codex_thread_id || null,
      cwd: args.cwd || process.cwd(),
      model: args.model,
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
      route: routeSummary(updated),
      adapter: adapter.status(),
    });
  } catch (error) {
    return jsonResult(String(error), { started: false, route_id: route.route_id, code: error.code || "CODEX_ADAPTER_ERROR" }, true);
  }
}

async function codexThreadTurn(args = {}) {
  const route = activateRoute(args);
  const threadId = args.codex_thread_id || route.codex_thread_id;
  if (!threadId) return jsonResult("codex_thread_id is required; call codex_thread_start first", { sent: false }, true);
  try {
    const result = await codexAdapterForRoute(route.route_id).sendTask({
      thread_id: threadId,
      text: args.text || args.task || args.prompt,
      input: args.input,
      timeoutMs: args.timeout_ms,
      cwd: args.cwd,
      model: args.model,
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
    const result = await codexAdapterForRoute(route.route_id).readThread(threadId);
    return jsonResult(`Codex thread read: ${threadId}`, { read: true, thread_id: threadId, result });
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
  return {
    route_id: activeRouteId,
    session_id: activeSessionId,
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
  const result = await askChatGPT({ ...args, port: args.port, timeout_ms: args.timeout_ms, prompt });
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
  const result = await askChatGPT({
    ...args,
    port: args.port,
    timeout_ms: args.timeout_ms,
    prompt: reportPrompt(brainState.goal, brainState.round, JSON.stringify(report, null, 2)),
  });
  if (result.isError) return result;
  const acknowledgement = resultText(result);
  brainState.lastWebReply = acknowledgement;
  persistActiveSession();
  return jsonResult("executor report sent to ChatGPT Web", {
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
  const result = await askChatGPT({
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

async function createChatGPTTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${CHATGPT_URL}`, { method: "PUT" });
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

async function findChatGPTTarget(port, session = activeSession) {
  const targets = await listTargets(port);
  const pages = targets.filter(item => item.type === "page");
  if (session?.target_id) {
    const stored = pages.find(item => item.id === session.target_id);
    if (stored) return stored;
  }
  if (session?.conversation?.id) {
    const stored = pages.find(item => conversationIdFromUrl(item.url || "") === session.conversation.id);
    if (stored) return stored;
  }
  const claimed = claimedTargetIds(session?.session_id || "");
  return pages.find(item => /chatgpt\.com/i.test(item.url || "") && !claimed.has(item.id)) || null;
}

async function ensureConnected(port, session = activeSession) {
  if (socket && socket.readyState === WebSocket.OPEN && target && session?.target_id === target.id) return;
  let page = await findChatGPTTarget(port, session) || await createChatGPTTarget(port);
  if (!page) {
    throw new Error(`no browser page found. Launch a browser with remote debugging on port ${port}, then open ${CHATGPT_URL}`);
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
        page = (page.id && targets.find(item => item.id === page.id)) || await findChatGPTTarget(port, session);
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

async function currentConversationData() {
  return evaluate(`(() => {
    const url = location.href;
    const match = location.pathname.match(/^\\/c\\/([^/]+)/i);
    const current = [...document.querySelectorAll('a[href*="/c/"]')].find(anchor => anchor.href.split('?')[0] === url.split('?')[0]);
    const rawTitle = (current?.getAttribute('aria-label') || current?.innerText || document.title || '').trim();
    const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
    return { id: match?.[1] || null, title, url, is_conversation: Boolean(match) };
  })()`);
}

async function visibleConversations(query = "") {
  const queryLiteral = JSON.stringify(String(query || "").trim().toLowerCase());
  return evaluate(`(() => {
    const query = ${queryLiteral};
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/c/"]')].map(anchor => {
      const url = anchor.href.split('?')[0];
      const match = new URL(url).pathname.match(/^\\/c\\/([^/]+)/i);
      const rawTitle = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
      const title = rawTitle.replace('，已置顶对话', '').replace('（未读）', '').trim();
      return { id: match?.[1] || null, title, url, current: url === location.href.split('?')[0] };
    }).filter(item => item.id && item.title && !seen.has(item.id) && seen.add(item.id))
      .filter(item => !query || item.title.toLowerCase().includes(query));
  })()`);
}

async function listConversations(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  try {
    await ensureConnected(port, activeSession);
    const conversations = await visibleConversations(args.query);
    const current = await currentConversationData();
    selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    persistActiveSession();
    return jsonResult(`found ${conversations.length} visible ChatGPT conversations`, {
      conversations,
      current,
      count: conversations.length,
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
  if (brainState.goal && !args.force) {
    return jsonResult("an active brain-hand task exists; call brain_reset or pass force=true before switching conversations", {
      selected: false,
      active_goal: brainState.goal,
      session_id: activeSessionId,
    }, true);
  }
  try {
    await ensureConnected(port, activeSession);
    let destination = safeConversationUrl(args.url || args.conversation_id || args.id);
    let chosen = null;
    if (args.title) {
      const conversations = await visibleConversations();
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
    if (!destination) return jsonResult("provide title, conversation_id, id, or a chatgpt.com conversation url", { selected: false }, true);
    const safeUrl = safeConversationUrl(destination);
    if (!safeUrl) return jsonResult("only chatgpt.com conversation URLs or conversation IDs are allowed", { selected: false }, true);
    const destinationId = conversationIdFromUrl(safeUrl);
    const current = await currentConversationData();
    if (current.url.split('?')[0] !== safeUrl) await cdpRaw("Page.navigate", { url: safeUrl });
    const deadline = Date.now() + Math.min(Math.max(Number(args.timeout_ms || 15000), 5000), 60000);
    let state = current;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      state = await currentConversationData();
      if (state.id === destinationId && state.url.split('?')[0] === safeUrl) break;
    }
    if (state.id !== destinationId) return jsonResult("timed out waiting for the selected conversation to open", { selected: false, url: safeUrl }, true);
    selectedConversation = { id: state.id, title: chosen?.title || state.title, url: state.url };
    persistActiveSession();
    return jsonResult(`selected ChatGPT conversation: ${selectedConversation.title || selectedConversation.id}`, {
      selected: true,
      conversation: selectedConversation,
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
  try {
    await ensureConnected(port, activeSession);
    const current = await currentConversationData();
    selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    persistActiveSession();
    return jsonResult(current.is_conversation ? `current ChatGPT conversation: ${current.title || current.id}` : "ChatGPT is on the home page", {
      current,
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
  const executable = browserCandidates().find(candidate => fs.existsSync(candidate));
  if (!executable) {
    return {
      launched: false,
      message: "Chrome or Edge was not found. Start one manually with remote debugging enabled.",
      command: `chrome.exe --remote-debugging-port=${portOf(args)} --user-data-dir=\\"${defaultProfileDir()}\\" ${CHATGPT_URL}`,
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
    CHATGPT_URL,
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { launched: true, executable, port, profile_dir: profileDir, url: CHATGPT_URL };
}

async function browserStatus(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  try {
    const targets = await listTargets(port);
    return jsonResult("browser is reachable", {
      connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      port,
      route_id: activeRouteId,
      route_status: activeRoute?.status || "idle",
      session_id: activeSessionId,
      assigned_target_id: activeSession?.target_id || null,
      assigned_conversation_id: activeSession?.conversation?.id || null,
      targets: targets.map(item => ({
        id: item.id,
        type: item.type,
        title: item.title,
        url: item.url,
        conversation_id: conversationIdFromUrl(item.url || ""),
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
  try {
    ensureActiveSession(args);
    await ensureConnected(port, activeSession);
    const health = await evaluate(selectorHealthScript());
    return jsonResult(`ChatGPT Web adapter health: ${health?.ok ? "ok" : "degraded"}`, {
      healthy: Boolean(health?.ok),
      session_id: activeSessionId,
      browser_target_id: activeSession?.target_id || null,
      strategies: health?.strategies || [],
    }, !health?.ok);
  } catch (error) {
    return jsonResult(String(error), { healthy: false, session_id: activeSessionId, port }, true);
  }
}

async function openChatGPT(args = {}) {
  activateRoute(args);
  const port = portOf(args);
  let page;
  try {
    page = await findChatGPTTarget(port, activeSession);
  } catch (error) {
    return jsonResult(String(error), { opened: false, port }, true);
  }
  if (!page) {
    try {
      page = await createChatGPTTarget(port);
    } catch {}
  }
  if (!page) return jsonResult(`open ${CHATGPT_URL} manually in the remote-debug browser`, { opened: false, port }, true);
  try {
    await connectToTarget(page);
    if (!/chatgpt\.com/i.test(page.url || "")) await cdpRaw("Page.navigate", { url: CHATGPT_URL });
    try {
      const current = await currentConversationData();
      selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : null;
    } catch {}
    activeSession.target_id = page.id || null;
    activeSession.target_url = page.url || CHATGPT_URL;
    persistActiveSession();
    return jsonResult("ChatGPT Web page is ready; sign in manually if needed", {
      opened: true,
      url: target?.url || CHATGPT_URL,
      port,
      session_id: activeSessionId,
      browser_target_id: activeSession.target_id,
    });
  } catch (error) {
    return jsonResult(String(error), { opened: false, port, session_id: activeSessionId }, true);
  }
}

async function pageSnapshot() {
  return evaluate(`(() => {
    const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    let messages = assistantNodes.map(node => (node.innerText || '').trim()).filter(Boolean);
    if (!messages.length) {
      messages = [...document.querySelectorAll('article')].map(node => (node.innerText || '').trim()).filter(Boolean);
    }
    const buttons = [...document.querySelectorAll('button')];
    const streamingMarkup = Boolean(document.querySelector('.streaming-animation'));
    const generating = streamingMarkup || buttons.some(button => /stop|generating|停止|生成中/i.test(
      (button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')
    ));
    const bodyText = (document.body?.innerText || '').slice(0, 3000);
    const loginRequired = location.pathname.includes('/auth/') || /log in|sign up|登录|注册/i.test(bodyText);
    return { url: location.href, loginRequired, messages, last: messages.at(-1) || '', generating };
  })()`);
}

async function askChatGPT(args = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return jsonResult("prompt is required", { sent: false }, true);
  const port = portOf(args);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms || 120000), 10000), 300000);
  try {
    ensureActiveSession(args);
    await ensureConnected(port, activeSession);
    const before = await pageSnapshot();
    if (before.loginRequired) {
      return jsonResult("ChatGPT Web requires manual sign-in in the dedicated browser", { sent: false, url: before.url }, true);
    }
    const promptLiteral = JSON.stringify(prompt);
    const inputSelectorsLiteral = JSON.stringify(SELECTOR_STRATEGIES.map(strategy => strategy.input));
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
    const sent = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const send = document.querySelector('button[data-testid="send-button"]')
        || buttons.find(button => /send|发送/i.test(button.getAttribute('aria-label') || '') && !/stop|停止/i.test(button.getAttribute('aria-label') || ''));
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
      const state = await pageSnapshot();
      if (state.loginRequired) return jsonResult("ChatGPT Web requested sign-in after submission", { sent: true }, true);
      const changed = state.last && (state.last !== before.last || state.messages.length > before.messages.length);
      if (changed && state.last === previous) stablePolls += 1;
      else if (changed) { previous = state.last; stablePolls = 0; }
      if (changed && !state.generating && stablePolls >= 2) {
        const current = await currentConversationData();
        selectedConversation = current.is_conversation ? { id: current.id, title: current.title, url: current.url } : selectedConversation;
        persistActiveSession();
        return jsonResult(state.last, { sent: true, reply: state.last, url: state.url, session_id: activeSessionId, browser_target_id: activeSession?.target_id || null });
      }
    }
    persistActiveSession();
    return jsonResult("timed out waiting for a stable ChatGPT Web reply", { sent: true, last: previous, session_id: activeSessionId }, true);
  } catch (error) {
    return jsonResult(String(error), { sent: false, port, session_id: activeSessionId }, true);
  }
}

const TOOLS = [
  {
    name: "bridge_route_create",
    description: "Create a lightweight Control Plane route that maps one executor thread to one ChatGPT Web session/tab. The Codex Adapter can drive the bound thread through App Server.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string", description: "Stable route key, for example pokemon-rl." },
      name: { type: "string" },
      codex_thread_id: { type: "string", description: "Optional Codex Thread ID for Control Plane metadata." },
      session_id: { type: "string", description: "ChatGPT bridge session to bind to this route." },
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
    description: "Bind or update a route's Codex thread, ChatGPT session, target tab, and conversation metadata.",
    inputSchema: { type: "object", properties: {
      route_id: { type: "string" },
      name: { type: "string" },
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
      effort: { type: "string" },
      timeout_ms: { type: "integer", default: 120000 },
    }, required: ["route_id"] },
  },
  {
    name: "codex_thread_read",
    description: "Read the metadata for the Codex thread bound to a route through the App Server protocol.",
    inputSchema: { type: "object", properties: { route_id: { type: "string" }, codex_thread_id: { type: "string" } }, required: ["route_id"] },
  },
  {
    name: "chatgpt_browser_session_create",
    description: "Create a persistent bridge session that owns one ChatGPT browser tab. Use a different session_id for each independent task; do not delete sessions through the bridge.",
    inputSchema: { type: "object", properties: {
      session_id: { type: "string", description: "Stable task/session key, for example project-alpha or project-beta." },
      name: { type: "string", description: "Human-readable session name." },
    }, required: ["session_id"] },
  },
  {
    name: "chatgpt_browser_session_list",
    description: "List persistent bridge sessions, their assigned browser target, ChatGPT conversation, and brain-hand progress.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chatgpt_browser_launch",
    description: "Launch a dedicated Chrome/Edge profile with remote debugging and open ChatGPT Web. The user must sign in manually. Never use this to bypass login or CAPTCHA.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT }, profile_dir: { type: "string" } } },
  },
  {
    name: "chatgpt_browser_status",
    description: "Read-only check of the remote-debug browser and visible tabs.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_health",
    description: "Check the active ChatGPT Web adapter's selector strategies and report UI health without sending a prompt.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_open",
    description: "Open or connect to a visible ChatGPT Web page in the remote-debug browser. Use before asking if no page is connected.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_list_conversations",
    description: "List visible ChatGPT Web sidebar conversations with titles, IDs, URLs, and the current selection. Use query to filter titles.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_select_conversation",
    description: "Select a visible ChatGPT Web conversation by exact or unique title, conversation ID, or chatgpt.com conversation URL. Refuses to switch during an active brain-hand task unless force=true.",
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
    description: "Return the currently selected ChatGPT Web conversation title, ID, and URL.",
    inputSchema: { type: "object", properties: { port: { type: "integer", default: DEFAULT_PORT } } },
  },
  {
    name: "chatgpt_browser_ask",
    description: "Send an explicit user-approved prompt through the visible ChatGPT Web page and return the visible assistant reply. Do not forward passwords, API keys, private credentials, or unapproved secrets.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, port: { type: "integer", default: DEFAULT_PORT }, timeout_ms: { type: "integer", default: 120000 } }, required: ["prompt"] },
  },
  {
    name: "brain_plan",
    description: "Start or reset the brain-hand mode. Ask ChatGPT Web to produce one concrete, verifiable next task for the configured executor. The web model plans; the executor works in the connected workspace.",
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
    description: "Send the executor's result to the planning brain. Send concise final outcomes, changed files, tests, blockers, and evidence; never send hidden chain-of-thought, passwords, or tokens.",
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
    description: "Ask the planning brain to review the latest Luna execution report and classify it as continue, completed, blocked, or repeated, with the next task and acceptance criteria.",
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

for (const tool of TOOLS) {
  if (!tool.inputSchema?.properties || tool.name.includes("session_") || tool.name.startsWith("bridge_route_")) continue;
  tool.inputSchema.properties.session_id = {
    type: "string",
    default: DEFAULT_SESSION_ID,
    description: "Persistent bridge session key. Reuse one key when related tool calls should share a ChatGPT browser tab; use a distinct key for independent work.",
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
  "brain_plan",
  "executor_report",
  "brain_review",
  "continue_task",
  "brain_status",
  "brain_reset",
  "codex_thread_start",
  "codex_thread_turn",
  "codex_thread_read",
]);

async function callToolDirect(name, args) {
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
  if (name === "chatgpt_browser_session_create") return createSession(args);
  if (name === "chatgpt_browser_session_list") return listSessions();
  if (name === "chatgpt_browser_launch") return jsonResult("dedicated browser launched; sign in manually", launchBrowser(args));
  if (name === "chatgpt_browser_status") return browserStatus(args);
  if (name === "chatgpt_browser_health") return browserHealth(args);
  if (name === "chatgpt_browser_open") return openChatGPT(args);
  if (name === "chatgpt_browser_list_conversations") return listConversations(args);
  if (name === "chatgpt_browser_select_conversation") return selectConversation(args);
  if (name === "chatgpt_browser_current_conversation") return currentConversation(args);
  if (name === "chatgpt_browser_ask") return askChatGPT(args);
  if (name === "brain_plan") return brainPlan(args);
  if (name === "executor_report") return executorReport(args);
  if (name === "brain_review") return brainReview(args);
  if (name === "continue_task") return continueTask(args);
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
