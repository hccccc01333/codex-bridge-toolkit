const TOOLKITS = Object.freeze([
  {
    id: "web-bridge",
    display_name: "Web LLM Conversation Bridge",
    status: "stable",
    description: "把 Codex 或 OpenCode 任务连接到可见的 ChatGPT Web 或 DeepSeek Web；网页端负责规划/审查，本地宿主负责执行。每个宿主 context 使用独立 worker，可并行运行单次、指定轮次或持续协作。",
    tools: ["bridge_discover", "bridge_connect", "bridge_send", "bridge_receive", "bridge_run"],
  },
  {
    id: "executor-hosts",
    display_name: "Executor Host Adapters",
    status: "experimental",
    description: "为同一种网页大脑桥接提供并列的本地执行宿主：Codex App Server 与 OpenCode serve HTTP API。OpenCode 也可以反过来把本插件作为本地 stdio MCP server 使用。",
    tools: ["executor_provider_list", "codex_adapter_status", "codex_thread_start", "codex_thread_turn", "codex_thread_read", "codex_source_thread_read", "bridge_host_status"],
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
    description: "读取并绑定当前本地 Git/GitHub 工作区的仓库、分支、远端和改动摘要，帮助 Codex 与网页大脑共享可验证的工作区上下文；不执行 GitHub 写操作。",
    tools: ["github_workspace_status", "github_workspace_bind"],
  },
  {
    id: "mcp-host-compatibility",
    display_name: "MCP Host Compatibility",
    status: "experimental",
    description: "报告 Codex、通用 stdio MCP 宿主和 DevSpace 的兼容边界；不会把 ChatGPT 网页端冒充成本地 MCP 宿主。",
    tools: ["bridge_host_status"],
  },
  {
    id: "artifact-workspace",
    display_name: "Artifact Workspace",
    status: "experimental",
    description: "先只读发现本地素材，再按用户明确选择读取有界文本；Word/PPT/PDF 仍只返回元数据，不上传文件，Notion 仍是 URL 引用占位。",
    tools: ["artifact_workspace_status", "artifact_workspace_read"],
  },
  {
    id: "web-session-swarm",
    display_name: "Web Session Swarm",
    status: "experimental",
    description: "一次编排多个可见网页模型会话；每个成员使用独立 MCP worker、浏览器目标和 watchdog，共享同一个本地 Git 工作区摘要，异常时 fail-closed 暂停。",
    tools: ["bridge_swarm_list", "bridge_swarm_create", "bridge_swarm_status", "bridge_swarm_resume", "bridge_swarm_run", "bridge_swarm_pause", "bridge_swarm_stop"],
  },
]);

export const TOOLKIT_SERIES_VERSION = "0.8.0";

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
