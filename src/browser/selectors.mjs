import { getBrainProvider, selectorHealthScript as providerSelectorHealthScript } from "../adapters/web_brain.mjs";

export const SELECTOR_STRATEGIES = Object.freeze(
  getBrainProvider("chatgpt").input_selectors.map((input, index) => Object.freeze({
    name: index === 0 ? "contenteditable-role" : index === 1 ? "enabled-textarea" : "contenteditable-fallback",
    input,
    send: getBrainProvider("chatgpt").send_selectors[0],
  })),
);

export function selectorHealthScript(provider = "chatgpt") {
  return providerSelectorHealthScript(provider);
}
