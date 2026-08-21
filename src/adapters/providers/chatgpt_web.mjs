import { getBrainProvider } from "../web_brain.mjs";
import { createWebLLMAdapter } from "../web_llm_adapter.mjs";

export const CHATGPT_WEB_ADAPTER = createWebLLMAdapter(getBrainProvider("chatgpt"));
