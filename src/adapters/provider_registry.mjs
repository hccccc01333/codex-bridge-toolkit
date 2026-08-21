import { CHATGPT_WEB_ADAPTER } from "./providers/chatgpt/index.mjs";
import { DEEPSEEK_WEB_ADAPTER } from "./providers/deepseek/index.mjs";

const ADAPTERS = Object.freeze({
  chatgpt: CHATGPT_WEB_ADAPTER,
  deepseek: DEEPSEEK_WEB_ADAPTER,
});

export function getWebLLMAdapter(provider = "chatgpt") {
  const id = String(provider || "chatgpt").trim().toLowerCase();
  const adapter = ADAPTERS[id];
  if (!adapter) {
    const error = new Error(`unsupported web LLM adapter: ${id}`);
    error.code = "WEB_LLM_ADAPTER_UNSUPPORTED";
    throw error;
  }
  return adapter;
}

export function listWebLLMAdapters() {
  return Object.values(ADAPTERS).map(adapter => ({
    id: adapter.id,
    display_name: adapter.display_name,
    start_url: adapter.profile.start_url,
  }));
}
