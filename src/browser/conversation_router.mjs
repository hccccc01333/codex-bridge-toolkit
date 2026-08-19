const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);

export function conversationIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^\/c\/([^/]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function safeConversationUrl(rawUrlOrId) {
  const value = String(rawUrlOrId || "").trim();
  if (!value) return null;
  if (/^[A-Za-z0-9_-]{8,}$/.test(value)) return `https://chatgpt.com/c/${value}`;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!CHATGPT_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!/^\/c\/[A-Za-z0-9_-]+$/i.test(url.pathname)) return null;
  return `https://chatgpt.com${url.pathname}`;
}

export function conversationMatches({ expectedId, actualId, actualUrl } = {}) {
  const expected = String(expectedId || "").trim();
  if (!expected) return true;
  const actual = String(actualId || conversationIdFromUrl(actualUrl) || "").trim();
  return Boolean(actual) && actual === expected;
}
