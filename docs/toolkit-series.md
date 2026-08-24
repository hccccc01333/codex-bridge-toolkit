# Codex Bridge Toolkit Series

## 中文（默认）

这个仓库现在是一个插件系列工具包，而不是只提供一个网页对话桥：

| 工具包 | 作用 | 默认行为 |
| --- | --- | --- |
| Web LLM Conversation Bridge | Codex ↔ ChatGPT Web / DeepSeek Web | 可见浏览器、目标校验、单次/指定轮次/持续模式；不同 Codex 对话使用独立 worker 并行 |
| Executor Host Adapters | Codex ↔ Web 与 OpenCode ↔ Web 的并列本地宿主适配 | Codex 使用 App Server；OpenCode 使用本地 MCP 或显式 `opencode serve` HTTP API |
| Browser Watchdog | 检查 Edge/Chrome 网页会话是否可用 | 只读；不换标签页、不重发消息 |
| GitHub Workspace | 把本地 Git/GitHub 工作区摘要提供给 Codex 和网页大脑 | 自动绑定或手动绑定；只读；不 pull/push/commit |
| MCP Host Compatibility | 报告标准 stdio MCP、Codex、DevSpace 和 ChatGPT Web 的兼容边界 | 只读；DevSpace 仅声明通用 MCP 兼容，不冒充专用适配器 |
| Artifact Workspace | 先发现本地 Word/PPT/PDF/Markdown 等文件，再按选择读取有界 Markdown/文本/CSV | 只读；不自动读取、不上传；Word/PPT/PDF 正文和 Notion 仍是未来扩展 |
| Web Session Swarm | 编排多个明确选择的网页模型会话，统一绑定本地 Git 摘要并独立监控 | 实验功能；成员独立 worker/标签页/watchdog；失败 fail-closed 暂停 |

### 普通用户怎么用

安装或更新后重启 Codex，在新对话中直接说：

```text
列出这个插件的工具包
```

桥接：

```text
连接 ChatGPT 网页端
```

多连接：在不同 Codex 对话中分别连接不同的网页标签页，然后说：

```text
查看所有 Codex 和网页端连接
```

返回结果只显示连接名称、模型、网页对话标题、Codex 绑定来源和轮次，不要求用户输入 `session_id`、`targetId` 或 `route_id`。

浏览器守护：

```text
检查 ChatGPT 标签页是否卡住
启动一个名为“论文 ChatGPT”的浏览器守护，每 15 秒只读检查一次
查看浏览器守护状态
停止名为“论文 ChatGPT”的浏览器守护
```

工作区：

```text
检查当前 GitHub 工作区
```

这会读取仓库根目录、分支、远端、ahead/behind、改动文件和安全的下一步建议。真正提交、拉取、推送或修改 GitHub 之前，仍由用户明确确认。

宿主兼容性和本地素材：

```text
检查 DevSpace 是否兼容这个插件
扫描当前工作区的 Word、PPT 和 PDF 文件
```

宿主检查只报告标准 MCP transport 和当前实现边界。素材扫描只返回本地文件名、类型、大小和修改时间，不读取文档正文、不上传文件，也不会自动登录 Notion。

如果需要让 Codex读取文本素材，必须显式选择扫描结果中的相对路径：

```text
读取 README.md 和 docs/overview.md 的有限上下文
```

`artifact_workspace_read` 只支持 Markdown、纯文本和 CSV，并限制单文件/总字符数；对 Word、PPT、PDF 会返回“正文适配器尚未加入”，不会直接读取二进制内容。

### Web Session Swarm

Swarm 是多个网页会话的控制面，不会隐式创建或猜测网页目标。调用方先扫描浏览器并为每个成员提供人类可读的 provider、浏览器、窗口、标签页和对话选择。创建成功后，每个成员拥有：

- 独立 MCP worker 和 relay 状态；
- 独立浏览器目标和 conversation fingerprint；
- 独立 Browser Watchdog；
- 同一份只读本地 Git 工作区摘要。

组状态会汇总 `ready`、`running`、`waiting_for_login`、`completed` 和 `paused`。目标不一致、标签页关闭、页面卡死、生成超时、重复目标或 worker 不可用都会触发暂停。恢复只能由用户明确调用，插件不会自动换标签页、创建替代会话或重发消息。

连接网页端时，插件会把当前 Codex 工作目录的 Git 摘要自动绑定到这条连接；也可以对已有 route 使用 `github_workspace_bind` 重新绑定。绑定只保存仓库名、分支、HEAD 和改动摘要，不会访问 GitHub API，也不会执行 Git 写操作。

### OpenCode 宿主

OpenCode 与 Codex 是并列宿主，不共享宿主会话。OpenCode 用户可以把本插件配置为本地 stdio MCP server，在 OpenCode 当前对话里使用 `bridge_connect`、`bridge_send`、`bridge_receive` 和目标控制；如果要让控制面自动驱动独立 OpenCode 执行会话，则由用户在工作区显式启动 `opencode serve`，再把 `executor_provider` 设为 `opencode`，必要时提供 `executor_endpoint`、`executor_model` 和 `executor_agent`。

这两种用法共享网页端适配器、浏览器安全校验、工作区摘要、Watchdog、证据门禁和停止策略。OpenCode 没有被伪装成 Codex；它也没有 Codex 原生 Goal API，因此 Bridge Goal 只作为插件本地目标保存。

### 并行和健康上报

- 不同 Codex host context 使用不同 MCP worker，因此各自拥有独立的 CDP socket、网页标签页、relay engine 和 Codex worker。
- 同一 host context/route 内仍然串行化，避免两个操作同时写入同一网页对话。
- Browser Watchdog 可以把页面无响应、编辑器缺失、生成超时、选择器降级等异常写入 route event；它不会自动换标签页、刷新后重发或猜测网页内容。
- 这些检查是本地 CDP/DOM 观测，不是 Computer Use 模型，也不能可靠判断模型“降智”。

### 守护状态含义

`healthy` 表示网页可执行健康检查；`generating` 表示网页正在生成；`login_required`、`composer_missing`、`page_unresponsive`、`provider_tab_not_found` 和 `browser_unreachable` 都是需要人工处理的状态。守护不会因为异常自动创建新标签页，也不会重复发送可能已经成功的消息。

### 安全边界

- 不读取密码、Cookie、Token 或 API Key。
- 不访问私有网页接口，不绕过登录、验证码、限流或权限控制。
- 浏览器自动化只使用用户可见的页面和本机 CDP。
- GitHub 工具包默认只读；没有自动 commit、push、pull、issue、PR 或账号操作。
- 守护运行在当前 MCP 进程中；MCP 进程重启后不会假装恢复旧守护，需要用户重新启动。

## English

This repository is now an umbrella plugin toolkit series rather than a single browser bridge:

| Toolkit | Purpose | Default behavior |
| --- | --- | --- |
| Web LLM Conversation Bridge | Codex ↔ ChatGPT Web / DeepSeek Web | Visible browser, destination verification, one-shot/bounded/continuous modes |
| Executor Host Adapters | Parallel Codex ↔ Web and OpenCode ↔ Web host adapters | Codex App Server, or OpenCode local MCP / explicit `opencode serve` HTTP API |
| Browser Watchdog | Check whether a visible Edge/Chrome web session is usable | Read-only; never switches tabs or resends messages |
| GitHub Workspace | Share and bind a local Git/GitHub workspace summary with Codex and the web brain | Read-only; never pulls/pushes/commits |
| MCP Host Compatibility | Report generic stdio MCP compatibility and explicit DevSpace/ChatGPT Web boundaries | Read-only capability report |
| Artifact Workspace | Discover local document/presentation metadata and explicitly read bounded text context | Read-only; Word/PPT/PDF body adapters and Notion API remain unimplemented |
| Web Session Swarm | Coordinate multiple explicitly selected web conversations with independent workers and watchdogs | Experimental; failure pauses the group; no replacement tab or resend |

The public MCP entry points are `bridge_toolkit_list`, `bridge_toolkit_status`, `bridge_link_list`, `browser_watchdog_scan`, `browser_watchdog_start`, `browser_watchdog_status`, `browser_watchdog_stop`, `github_workspace_status`, `github_workspace_bind`, `bridge_host_status`, `executor_provider_list`, `artifact_workspace_status`, `artifact_workspace_read`, `bridge_swarm_list`, `bridge_swarm_create`, `bridge_swarm_status`, `bridge_swarm_resume`, `bridge_swarm_run`, `bridge_swarm_pause`, and `bridge_swarm_stop`.

Technical route/session/target identifiers remain internal. Separate Codex conversations can create separate persisted links; use `bridge_link_list` or the natural-language equivalent to inspect them.

The watchdog runs in the current MCP process. It is intentionally diagnostic and fail-closed: a degraded page is reported as a durable route event for manual recovery, not silently replaced or retried. The Swarm uses the same policy independently for each member. OpenCode is supported as a local stdio MCP host and, for managed execution, through the documented `opencode serve` HTTP API. DevSpace remains supported only through the generic stdio MCP contract until a dedicated adapter is added. Artifact Workspace reads only explicitly selected bounded Markdown/text/CSV context; Notion API access and Word/PPT/PDF body adapters remain future extension points.
