export const SELECTOR_STRATEGIES = Object.freeze([
  Object.freeze({
    name: "contenteditable-role",
    input: '[contenteditable="true"][role="textbox"]',
    send: 'button[data-testid="send-button"]',
  }),
  Object.freeze({
    name: "enabled-textarea",
    input: 'textarea:not([disabled])',
    send: 'button[data-testid="send-button"]',
  }),
  Object.freeze({
    name: "contenteditable-fallback",
    input: '[contenteditable="true"]',
    send: 'button[data-testid="send-button"]',
  }),
]);

export function selectorHealthScript() {
  const strategies = JSON.stringify(SELECTOR_STRATEGIES);
  return `(() => {
    const strategies = ${strategies};
    const result = strategies.map(strategy => ({
      name: strategy.name,
      input: Boolean(document.querySelector(strategy.input)),
      send: Boolean(document.querySelector(strategy.send)),
    }));
    return { ok: result.some(item => item.input && item.send), strategies: result };
  })()`;
}
