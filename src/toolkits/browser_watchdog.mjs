import { getWebLLMAdapter } from "../adapters/provider_registry.mjs";

function text(value) {
  return String(value ?? "").trim();
}

function validPort(value, fallback = 9222) {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

async function getJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 3000));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function targetMatches(target, selector = {}) {
  if (!target || target.type !== "page") return false;
  if (selector.target_id && target.id !== selector.target_id) return false;
  if (selector.target_url && target.url !== selector.target_url) return false;
  if (selector.target_title && target.title !== selector.target_title) return false;
  return true;
}

function chooseTarget(targets, selector = {}) {
  const pages = targets.filter(target => target?.type === "page");
  const selected = pages.filter(target => targetMatches(target, selector));
  if (selector.target_id || selector.target_url || selector.target_title) {
    if (selected.length === 1) return { target: selected[0] };
    return {
      target: null,
      selection_error: selected.length ? "目标标签页选择不唯一" : "目标标签页不存在",
    };
  }
  if (pages.length === 1) return { target: pages[0] };
  return { target: null, selection_error: "检测到多个标签页，请指定目标标签页" };
}

function healthExpression(provider) {
  const profile = getWebLLMAdapter(provider).profile;
  const health = getWebLLMAdapter(provider).selectorHealthScript();
  return `(() => {
    const selectorHealth = (${health});
    const body = (document.body?.innerText || '').slice(0, 5000).toLowerCase();
    const loginTerms = ${JSON.stringify(profile.login_terms)};
    const assistantSelectors = ${JSON.stringify(profile.assistant_selectors)};
    const nodes = [...new Set(assistantSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    const buttons = [...document.querySelectorAll('button')];
    const labels = buttons.map(button => ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase());
    const generatingTerms = ${JSON.stringify(profile.generating_terms)};
    return {
      ready_state: document.readyState,
      url: location.href,
      title: document.title,
      login_required: location.pathname.includes('/auth/') || loginTerms.some(term => body.includes(term.toLowerCase())),
      composer_available: Boolean(document.querySelector(${JSON.stringify(profile.input_selectors.join(","))})),
      assistant_count: nodes.length,
      generating: generatingTerms.some(term => labels.some(label => label.includes(term.toLowerCase()))),
      selector_health: selectorHealth,
    };
  })()`;
}

async function evaluateTarget(target, expression, timeoutMs = 3500) {
  if (!target?.webSocketDebuggerUrl) throw new Error("目标标签页没有可用的 DevTools 连接");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let commandId = 0;
  const pending = new Map();
  const finishPending = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, Math.max(500, Number(timeoutMs) || 3500));
  });
  return new Promise((resolve, reject) => {
    const close = error => {
      finishPending(error);
      try { socket.close(); } catch {}
      reject(error);
    };
    socket.addEventListener("open", async () => {
      try {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        try { socket.close(); } catch {}
        if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || "网页健康检查执行失败");
        resolve(result?.result?.value || null);
      } catch (error) {
        close(error);
      }
    }, { once: true });
    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data));
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || "DevTools command failed"));
        else request.resolve(message.result);
      } catch (error) {
        close(error);
      }
    });
    socket.addEventListener("error", () => close(new Error("网页 DevTools 连接失败")), { once: true });
    socket.addEventListener("close", () => {
      if (pending.size) finishPending(new Error("网页标签页在健康检查期间断开"));
    }, { once: true });
  });
}

export async function scanBrowser({ port = 9222, provider = "chatgpt", target_id, target_title, target_url, timeout_ms = 3500 } = {}) {
  const normalizedPort = validPort(port);
  const adapter = getWebLLMAdapter(provider);
  let version;
  let targets;
  try {
    [version, targets] = await Promise.all([
      getJson(`http://127.0.0.1:${normalizedPort}/json/version`, timeout_ms),
      getJson(`http://127.0.0.1:${normalizedPort}/json/list`, timeout_ms),
    ]);
  } catch (error) {
    return {
      ok: false,
      state: "browser_unreachable",
      provider: adapter.id,
      port: normalizedPort,
      message: `浏览器调试端口不可用：${String(error)}`,
      checked_at: new Date().toISOString(),
    };
  }
  const providerPages = (Array.isArray(targets) ? targets : []).filter(target => target?.type === "page" && adapter.detect(target.url));
  const selection = chooseTarget(providerPages, { target_id, target_title, target_url });
  if (!selection.target) {
    return {
      ok: false,
      state: providerPages.length ? "target_selection_required" : "provider_tab_not_found",
      provider: adapter.id,
      port: normalizedPort,
      browser: version?.Browser || null,
      pages: providerPages.map(target => ({ title: text(target.title) || "未命名标签页", url: text(target.url) })),
      message: selection.selection_error || `没有发现 ${adapter.display_name} 标签页`,
      checked_at: new Date().toISOString(),
    };
  }
  const target = selection.target;
  let health;
  try {
    health = await evaluateTarget(target, healthExpression(adapter.id), timeout_ms);
  } catch (error) {
    return {
      ok: false,
      state: "page_unresponsive",
      provider: adapter.id,
      port: normalizedPort,
      browser: version?.Browser || null,
      tab: { title: text(target.title) || "未命名标签页", url: text(target.url) },
      message: `标签页存在，但网页健康检查失败：${String(error)}`,
      recovery: "只允许刷新原标签页；不要自动打开新标签页或重复发送消息。",
      checked_at: new Date().toISOString(),
    };
  }
  const state = health.login_required
    ? "login_required"
    : health.ready_state !== "complete"
      ? "page_loading"
      : !health.composer_available
        ? "composer_missing"
        : health.generating
          ? "generating"
          : health.selector_health?.ok
            ? "healthy"
            : "selector_degraded";
  return {
    ok: state === "healthy" || state === "generating",
    state,
    provider: adapter.id,
    port: normalizedPort,
    browser: version?.Browser || null,
    tab: {
      title: text(target.title) || health.title || "未命名标签页",
      url: health.url || target.url,
    },
    health: {
      login_required: Boolean(health.login_required),
      composer_available: Boolean(health.composer_available),
      assistant_count: Number(health.assistant_count || 0),
      generating: Boolean(health.generating),
      selector_health: health.selector_health || null,
    },
    checked_at: new Date().toISOString(),
  };
}
