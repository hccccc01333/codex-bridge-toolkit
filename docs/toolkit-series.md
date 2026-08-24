# Codex Bridge Toolkit Series

## 中文（默认）

这个仓库现在是一个插件系列工具包，而不是只提供一个网页对话桥：

| 工具包 | 作用 | 默认行为 |
| --- | --- | --- |
| Web LLM Conversation Bridge | Codex ↔ ChatGPT Web / DeepSeek Web | 可见浏览器、目标校验、单次/指定轮次/持续模式 |
| Browser Watchdog | 检查 Edge/Chrome 网页会话是否可用 | 只读；不换标签页、不重发消息 |
| GitHub Workspace | 把本地 Git/GitHub 工作区摘要提供给 Codex 和网页大脑 | 只读；不 pull/push/commit |

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
| Browser Watchdog | Check whether a visible Edge/Chrome web session is usable | Read-only; never switches tabs or resends messages |
| GitHub Workspace | Share a local Git/GitHub workspace summary with Codex and the web brain | Read-only; never pulls/pushes/commits |

The public MCP entry points are `bridge_toolkit_list`, `bridge_toolkit_status`, `bridge_link_list`, `browser_watchdog_scan`, `browser_watchdog_start`, `browser_watchdog_status`, `browser_watchdog_stop`, and `github_workspace_status`.

Technical route/session/target identifiers remain internal. Separate Codex conversations can create separate persisted links; use `bridge_link_list` or the natural-language equivalent to inspect them.

The watchdog runs in the current MCP process. It is intentionally diagnostic and fail-closed: a degraded page is reported for manual recovery, not silently replaced or retried.
