const CHATGPT = Object.freeze({
  id: "chatgpt",
  display_name: "ChatGPT Web",
  selection_hint: "默认通用规划与审查，适合大多数任务。",
  start_url: "https://chatgpt.com/",
  hosts: Object.freeze(["chatgpt.com", "www.chatgpt.com"]),
  input_selectors: Object.freeze([
    '[contenteditable="true"][role="textbox"]',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
  ]),
  input_strategy_names: Object.freeze(["contenteditable-role", "enabled-textarea", "contenteditable-fallback"]),
  send_selectors: Object.freeze([
    'button[data-testid="send-button"]',
  ]),
  attachment_input_selectors: Object.freeze([
    'input[type="file"]',
  ]),
  attachment_download_selectors: Object.freeze([
    'a[download]',
    'button[aria-label*="download" i]',
    'button[aria-label*="下载"]',
  ]),
  assistant_selectors: Object.freeze([
    '[data-message-author-role="assistant"]',
  ]),
  conversation_link_selectors: Object.freeze([
    'a[href*="/c/"]',
  ]),
  conversation_prefixes: Object.freeze(["/c/"]),
  conversation_path_patterns: Object.freeze(["/c/([A-Za-z0-9_-]+)(?:/|$)"]),
  default_conversation_prefix: "/c/",
  login_terms: Object.freeze(["log in", "sign up", "登录", "注册"]),
  generating_terms: Object.freeze(["stop", "generating", "停止", "生成中"]),
  send_terms: Object.freeze(["send", "发送"]),
});

const DEEPSEEK = Object.freeze({
  id: "deepseek",
  display_name: "DeepSeek Web",
  selection_hint: "中文推理与成本敏感任务的可选大脑。",
  start_url: "https://chat.deepseek.com/",
  hosts: Object.freeze(["chat.deepseek.com"]),
  input_selectors: Object.freeze([
    'textarea:not([disabled])',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ]),
  input_strategy_names: Object.freeze(["enabled-textarea", "contenteditable-role", "contenteditable-fallback"]),
  send_selectors: Object.freeze([
    'button[type="submit"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送"]',
  ]),
  attachment_input_selectors: Object.freeze([
    'input[type="file"]',
  ]),
  attachment_download_selectors: Object.freeze([
    'a[download]',
    'button[aria-label*="download" i]',
    'button[aria-label*="下载"]',
  ]),
  assistant_selectors: Object.freeze([
    '[data-testid*="assistant"]',
    '[class*="ds-markdown"]',
    '[class*="markdown"]',
  ]),
  conversation_link_selectors: Object.freeze([
    'a[href*="/a/chat/"]',
    'a[href*="/chat/"]',
  ]),
  conversation_prefixes: Object.freeze(["/a/chat/s/", "/chat/"]),
  conversation_path_patterns: Object.freeze([
    "/a/chat/s/([A-Za-z0-9_-]+)(?:/|$)",
    "/chat/([A-Za-z0-9_-]+)(?:/|$)",
  ]),
  default_conversation_prefix: "/a/chat/s/",
  login_terms: Object.freeze(["log in", "sign up", "登录", "注册", "login"]),
  generating_terms: Object.freeze(["stop", "generating", "停止", "生成中", "停止生成"]),
  send_terms: Object.freeze(["send", "发送"]),
});

const PROVIDERS = Object.freeze({ chatgpt: CHATGPT, deepseek: DEEPSEEK });

export const DEFAULT_BRAIN_PROVIDER = "chatgpt";

export function normalizeBrainProvider(value = DEFAULT_BRAIN_PROVIDER) {
  const id = String(value || DEFAULT_BRAIN_PROVIDER).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    const error = new Error("brain_provider must contain only lowercase letters, numbers, or hyphens");
    error.code = "BRAIN_PROVIDER_INVALID";
    throw error;
  }
  if (!PROVIDERS[id]) {
    const error = new Error(`unsupported brain_provider: ${id}`);
    error.code = "BRAIN_PROVIDER_UNSUPPORTED";
    throw error;
  }
  return id;
}

export function getBrainProvider(value = DEFAULT_BRAIN_PROVIDER) {
  return PROVIDERS[normalizeBrainProvider(value)];
}

export function listBrainProviders() {
  return Object.values(PROVIDERS).map(provider => ({
    id: provider.id,
    display_name: provider.display_name,
    selection_hint: provider.selection_hint,
    start_url: provider.start_url,
    hosts: [...provider.hosts],
    conversation_prefixes: [...provider.conversation_prefixes],
    conversation_path_patterns: [...(provider.conversation_path_patterns || [])],
  }));
}

export function providerMatchesUrl(providerOrId, rawUrl) {
  const provider = typeof providerOrId === "string" ? getBrainProvider(providerOrId) : providerOrId;
  try {
    const url = new URL(String(rawUrl || ""));
    return provider.hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function selectorHealthScript(providerOrId = DEFAULT_BRAIN_PROVIDER) {
  const provider = typeof providerOrId === "string" ? getBrainProvider(providerOrId) : providerOrId;
  const inputSelectors = JSON.stringify(provider.input_selectors);
  const inputStrategyNames = JSON.stringify(provider.input_strategy_names || []);
  const sendSelectors = JSON.stringify(provider.send_selectors);
  const sendTerms = JSON.stringify(provider.send_terms);
  return `(() => {
    const inputSelectors = ${inputSelectors};
    const inputStrategyNames = ${inputStrategyNames};
    const sendSelectors = ${sendSelectors};
    const sendTerms = ${sendTerms};
    const buttons = [...document.querySelectorAll('button')];
    const sendByLabel = buttons.some(button => {
      const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).toLowerCase();
      return sendTerms.some(term => label.includes(term.toLowerCase()));
    });
    const strategies = inputSelectors.map((input, index) => ({
      name: inputStrategyNames[index] || ('input-' + index),
      input,
      send: Boolean(document.querySelector(input) && (sendSelectors.some(selector => document.querySelector(selector)) || sendByLabel)),
    }));
    return {
      // A blank composer can expose a voice control instead of a send button.
      // The send control is checked after text insertion, not during health.
      ok: strategies.some(item => Boolean(document.querySelector(item.input))),
      provider: ${JSON.stringify(provider.id)},
      strategies,
    };
  })()`;
}
