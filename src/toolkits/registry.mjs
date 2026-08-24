const TOOLKITS = Object.freeze([
  {
    id: "web-bridge",
    display_name: "Web LLM Conversation Bridge",
    status: "stable",
    description: "把当前 Codex 任务连接到可见的 ChatGPT Web 或 DeepSeek Web，并安全地进行单次、指定轮次或持续协作。",
    tools: ["bridge_discover", "bridge_connect", "bridge_send", "bridge_receive", "bridge_run"],
  },
  {
    id: "browser-watchdog",
    display_name: "Browser Watchdog",
    status: "stable",
    description: "只读检查 Edge/Chrome 可调试端点、网页标签页、登录状态、输入框和生成状态；异常时报告，不自动换标签页或重发消息。",
    tools: ["browser_watchdog_scan", "browser_watchdog_start", "browser_watchdog_status", "browser_watchdog_stop"],
  },
  {
    id: "github-workspace",
    display_name: "GitHub Workspace",
    status: "stable",
    description: "读取当前本地 Git/GitHub 工作区的仓库、分支、远端和改动摘要，帮助 Codex 与网页大脑共享可验证的工作区上下文。默认只读。",
    tools: ["github_workspace_status"],
  },
]);

export const TOOLKIT_SERIES_VERSION = "0.3.0";

export function listToolkits() {
  return TOOLKITS.map(toolkit => ({
    ...toolkit,
    tools: [...toolkit.tools],
  }));
}

export function toolkitById(id) {
  const wanted = String(id || "").trim().toLowerCase();
  return listToolkits().find(toolkit => toolkit.id === wanted) || null;
}
