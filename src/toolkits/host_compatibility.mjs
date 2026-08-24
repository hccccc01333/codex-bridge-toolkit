const HOST_PROFILES = Object.freeze({
  generic: {
    display_name: "Generic MCP host",
    status: "supported",
    transport: "stdio",
    protocol: "MCP tools/list + tools/call",
    notes: ["可被支持标准 stdio MCP 的宿主调用", "UI resource 是否显示取决于宿主能力"],
  },
  codex: {
    display_name: "Codex",
    status: "supported",
    transport: "stdio",
    protocol: "MCP tools/list + tools/call",
    notes: ["当前插件的主要宿主", "Codex 对话上下文可用于隔离并行 worker"],
  },
  opencode: {
    display_name: "OpenCode",
    status: "supported",
    transport: "stdio + optional local HTTP",
    protocol: "MCP tools/list + tools/call; optional opencode serve API",
    notes: [
      "OpenCode 可以把本插件作为本地 stdio MCP server 使用",
      "需要自动驱动独立 OpenCode 执行会话时，显式启动 opencode serve 并配置 endpoint",
      "本插件不会自动安装 OpenCode、读取其凭据或自动批准权限请求",
    ],
  },
  devspace: {
    display_name: "DevSpace",
    status: "generic_mcp_compatible",
    transport: "stdio",
    protocol: "MCP tools/list + tools/call",
    notes: ["仅声明标准 stdio MCP 兼容", "尚未实现 DevSpace 专用适配器或现场认证"],
  },
  chatgpt_web: {
    display_name: "ChatGPT Web",
    status: "not_supported_as_mcp_host",
    transport: "browser_page",
    protocol: null,
    notes: ["网页端是被桥接的 Brain，不是本地 MCP 宿主", "本插件不会把密码、Cookie 或私有接口交给网页端"],
  },
});

function normalizeHost(value) {
  const key = String(value || "generic").trim().toLowerCase().replace(/[ -]+/g, "_");
  return HOST_PROFILES[key] ? key : "generic";
}

export function hostCompatibilityStatus({ host = "generic" } = {}) {
  const selected = normalizeHost(host);
  return {
    schema_version: "0.1",
    selected_host: selected,
    selected: { ...HOST_PROFILES[selected], id: selected, notes: [...HOST_PROFILES[selected].notes] },
    hosts: Object.entries(HOST_PROFILES).map(([id, profile]) => ({
      id,
      display_name: profile.display_name,
      status: profile.status,
      transport: profile.transport,
      protocol: profile.protocol,
      notes: [...profile.notes],
    })),
    safety: {
      credentials: "never_collected",
      browser_mode: "visible_cdp_only",
      web_content: "untrusted_peer_content",
    },
  };
}
