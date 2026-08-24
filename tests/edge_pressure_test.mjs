#!/usr/bin/env node

import { getWebLLMAdapter } from "../src/adapters/provider_registry.mjs";

const port = Number(process.env.CHATGPT_BRIDGE_PORT || 9222);
const iterations = Math.min(Math.max(Number(process.env.EDGE_PRESSURE_ITERATIONS || 40), 5), 200);

async function listPages() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`could not read Edge DevTools targets: ${response.status}`);
  return response.json();
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "CDP request failed"));
    else request.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out connecting to Edge DevTools")), 8000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("could not connect to Edge DevTools"));
    }, { once: true });
  });
  return {
    async call(method, params = {}) {
      await ready;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async close() {
      await ready.catch(() => undefined);
      socket.close();
    },
  };
}

async function main() {
  const pages = (await listPages()).filter(page => page.type === "page");
  const page = pages.find(candidate => /chatgpt\.com|chat\.deepseek\.com/i.test(candidate.url || ""));
  if (!page) throw new Error("no ChatGPT or DeepSeek page is available on the configured Edge debugging port");
  const providerId = /chat\.deepseek\.com/i.test(page.url || "") ? "deepseek" : "chatgpt";
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  try {
    const healthResult = await cdp.call("Runtime.evaluate", {
      returnByValue: true,
      expression: getWebLLMAdapter(providerId).selectorHealthScript(),
    });
    const selectorHealth = healthResult?.result?.value || { ok: false, reason: "no health result" };
    const result = await cdp.call("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const samples = [];
        let latest = null;
        for (let iteration = 0; iteration < ${iterations}; iteration += 1) {
          const started = performance.now();
          const selectors = [
            '[data-message-author-role="assistant"]',
            '[data-testid*="assistant"]',
            '[class*="ds-markdown"]',
            '[class*="markdown"]',
          ];
          let nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
          nodes = [...new Set(nodes)].slice(-60);
          const messages = nodes.map(node => (node.innerText || '').trim()).filter(Boolean);
          const buttons = [...document.querySelectorAll('button')];
          const input = document.querySelector('[contenteditable="true"][role="textbox"], textarea:not([disabled])');
          const send = document.querySelector('button[data-testid="send-button"], button[type="submit"]');
          latest = {
            url: location.href,
            title: document.title,
            message_count: messages.length,
            body_text_length: (document.body?.innerText || '').length,
            button_count: buttons.length,
            composer_available: Boolean(input),
            send_control_available: Boolean(send),
          };
          samples.push(performance.now() - started);
        }
        return {
          iterations: samples.length,
          p50_ms: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
          p95_ms: Number((samples.slice().sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]).toFixed(3)),
          max_ms: Number(Math.max(...samples).toFixed(3)),
          latest,
        };
      })()`,
    });
    const value = result?.result?.value;
    if (!value) throw new Error("Edge page returned no pressure-test result");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      port,
      iterations,
      target_type: "existing-debuggable-page",
      provider: providerId,
      sent_messages: false,
      opened_replacement_tab: false,
      selector_health: selectorHealth,
      ...value,
    }, null, 2)}\n`);
  } finally {
    await cdp.close();
  }
}

main().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
