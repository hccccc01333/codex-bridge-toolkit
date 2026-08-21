function text(value) {
  return String(value ?? "").trim();
}

export function createWebLLMAdapter(profile) {
  if (!profile?.id) throw new TypeError("WebLLMAdapter requires a provider profile");
  return Object.freeze({
    id: profile.id,
    display_name: profile.display_name,
    profile,
    detect(rawUrl) {
      try {
        return profile.hosts.includes(new URL(String(rawUrl || "")).hostname.toLowerCase());
      } catch {
        return false;
      }
    },
    isLoggedIn(snapshot = {}) {
      return !Boolean(snapshot.loginRequired);
    },
    getConversationFingerprint(conversation = {}) {
      return {
        provider: profile.id,
        id: text(conversation.id),
        title: text(conversation.title),
        url: text(conversation.url),
      };
    },
    listConversations(document) {
      const links = profile.conversation_link_selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      return [...new Set(links)].map(link => ({
        title: text(link.innerText || link.getAttribute("aria-label")),
        url: text(link.href),
      })).filter(item => item.title || item.url);
    },
    selectConversation(document, url) {
      const destination = text(url);
      const link = this.listConversations(document).find(item => item.url === destination);
      if (!link) return false;
      const node = profile.conversation_link_selectors
        .flatMap(selector => [...document.querySelectorAll(selector)])
        .find(candidate => text(candidate.href) === destination);
      node?.click();
      return Boolean(node);
    },
    selectorHealthScript() {
      const inputSelectors = JSON.stringify(profile.input_selectors);
      const inputStrategyNames = JSON.stringify(profile.input_strategy_names || []);
      const sendSelectors = JSON.stringify(profile.send_selectors);
      const sendTerms = JSON.stringify(profile.send_terms);
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
        return { ok: strategies.some(item => item.send), provider: ${JSON.stringify(profile.id)}, strategies };
      })()`;
    },
    findComposer(document) {
      return profile.input_selectors.map(selector => document.querySelector(selector)).find(Boolean) || null;
    },
    findSendControl(document) {
      const buttons = [...document.querySelectorAll("button")];
      return profile.send_selectors.map(selector => document.querySelector(selector)).find(Boolean)
        || buttons.find(button => {
          const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.toLowerCase();
          return profile.send_terms.some(term => label.includes(term.toLowerCase()));
        })
        || null;
    },
    isGenerating(document) {
      const labels = [...document.querySelectorAll("button")].map(button => `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.toLowerCase());
      const body = text(document.body?.innerText).toLowerCase();
      return profile.generating_terms.some(term => labels.some(label => label.includes(term.toLowerCase())) || body.includes(term.toLowerCase()));
    },
    getLatestAssistantMessage(document) {
      const nodes = profile.assistant_selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      return text([...new Set(nodes)].at(-1)?.innerText);
    },
    stopGeneration(document) {
      const buttons = [...document.querySelectorAll("button")];
      const stop = buttons.find(button => {
        const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.toLowerCase();
        return profile.generating_terms.some(term => label.includes(term.toLowerCase()));
      });
      stop?.click();
      return Boolean(stop);
    },
  });
}
