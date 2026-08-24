# OpenCode ↔ Web LLM bridge

这个目录提供 OpenCode 用户的最小配置模板。把 `opencode.jsonc` 中的两个路径替换成：

- 本插件仓库中 `scripts/mcp_server.mjs` 的绝对路径；
- 需要由 OpenCode 执行任务的本地项目路径。

OpenCode 官方支持在 `mcp.servers` 下启动本地 stdio MCP server。重启 OpenCode 后，在对话中说：

```text
连接 ChatGPT 网页端，使用当前工作区，先建立连接，不要自动开始多轮。
```

登录可见网页端后，再明确给出目标。只做一次询问时使用 `bridge_send` 即可。

如果希望由控制面自动驱动独立 OpenCode 执行会话，先在项目工作区启动：

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

然后选择：

```json
{
  "executor_provider": "opencode",
  "executor_endpoint": "http://127.0.0.1:4096"
}
```

`executor_model` 可填 OpenCode 使用的 `provider/model`，`executor_agent` 可填 OpenCode agent 名称。插件不会自动安装 OpenCode、读取密码、自动批准权限、切换会话或重发不确定的消息。

如果希望 OpenCode 用户只用自然语言而不在每次调用中选择宿主，可以在 MCP server 的 `environment` 中设置 `CODEX_BRIDGE_EXECUTOR_PROVIDER=opencode` 和 `OPENCODE_SERVER_URL`；这只改变该 MCP server 进程的默认宿主，不会改变 Codex 用户的默认 ChatGPT Luna 配置。
