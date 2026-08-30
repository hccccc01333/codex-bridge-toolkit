# 🧰 Codex Bridge Toolkit Series

> 让网页大模型负责规划与审查，让 Codex 或 OpenCode 在本地工作区执行；所有连接都在可见浏览器和本地 MCP 中完成。

**默认语言：中文 · [English](README.en.md)**

**仓库：** [hccccc01333/codex-bridge-toolkit](https://github.com/hccccc01333/codex-bridge-toolkit)

![Node.js](https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)
![浏览器](https://img.shields.io/badge/Chrome%20%2F%20Edge-可见%20CDP-4285F4?logo=googlechrome&logoColor=white)
![本地优先](https://img.shields.io/badge/本地优先-10b981)
![版本](https://img.shields.io/badge/version-0.8.0-2563eb)

## 一句话理解

这是一个“网页大脑 ↔ 本地执行手”的桥接工具包：

```text
ChatGPT Web / DeepSeek Web
          │ 规划、提问、审查
          ▼
   Bridge Control Plane
      │              │
      ▼              ▼
  Codex Worker    OpenCode Worker
      │              │
      └──────┬───────┘
             ▼
       本地工作区、代码、测试、证据
```

用户只在当前宿主的对话里说话。插件负责发现可连接的浏览器、绑定网页会话、转发明确消息、保存连接状态、检查网页健康，并在目标不确定时暂停。

> 它不是 ChatGPT API，也不是 Cookie 或密码提取器；网页端始终由用户在可见浏览器中登录。

## 先看你属于哪一种用户

| 你使用的本地宿主 | 最适合的连接方式 | 关键说明 |
| --- | --- | --- |
| Codex Desktop / CLI | ChatGPT Web 或 DeepSeek Web ↔ Codex | 默认使用 Codex App Server worker，可同步插件管理的原生 Goal |
| OpenCode | ChatGPT Web 或 DeepSeek Web ↔ OpenCode | OpenCode 可以直接加载本插件的本地 stdio MCP；需要插件托管执行时，再显式启动 `opencode serve` |
| 其他 MCP 宿主 | 网页端 ↔ 当前宿主 | 只要支持标准 stdio MCP，就可以使用公共桥接工具；专用执行适配能力以宿主报告为准 |

Codex 和 OpenCode 是两个并列宿主，不会共用隐藏会话，也不会把 OpenCode 伪装成 Codex。网页适配器、浏览器安全校验、Control Plane、Watchdog 和停止策略是共享的；执行宿主适配器是分开的。

## 5 分钟开始使用

### 1. 安装

普通用户从 Codex 插件市场安装本插件，然后重启 Codex 并新建一个对话。

从 GitHub 克隆进行开发时：

```powershell
git clone https://github.com/hccccc01333/codex-bridge-toolkit.git
cd codex-bridge-toolkit
npm test
npm run check
```

普通用户不需要手动启动 `scripts/mcp_server.mjs`，也不需要填写 `session_id`、`targetId`、`route_id` 或 DevTools 端口。

### 2. 连接网页端

在新的 Codex 对话中直接说：

```text
连接 ChatGPT 网页端。
```

也可以改成：

```text
连接 DeepSeek 网页端。
```

桥接会扫描可连接的浏览器，并按“浏览器 → 窗口 → 标签页 → 网页对话”展示人类可读的选择。如果当前没有可调试的浏览器，它会自动启动独立的持久化 Edge 配置 `CodexBridgeEdge` 并打开网页端。

### 3. 第一次登录

在可见的 Edge 窗口中手动登录，然后回到同一个 Codex 对话说：

```text
登录好了，继续。
```

插件不会把 MCP 请求挂起等待登录，也不会读取密码、Cookie、Token 或验证码。登录成功后，后续连接会复用专用 Edge 配置。

### 4. 让插件创建目标

连接成功后，插件会在当前 Codex 对话中询问：

```text
你希望完成什么目标？
```

你只需回答目标，例如：

```text
修复当前项目所有 failing tests，并在每轮报告改动、测试和证据。
```

插件会把你的回答创建成 Bridge Goal。指定轮次或持续模式下，Codex 会进一步把它同步到插件管理的 Codex Worker 原生 Goal；只有返回结果中的 `native_goal.synced: true` 才表示同步成功。面板只显示状态，不负责提问或创建目标。

### 5. 选择连接模式

```text
只问一次：把这个架构问一下 ChatGPT，只返回网页端意见。
手动连接：先连接 DeepSeek，但不要自动发送。
指定轮次：使用 ChatGPT 规划和审查，往返 10 轮。
持续执行：持续完成当前目标，直到完成、阻塞或我停止。
```

模式含义：

| 模式 | 含义 |
| --- | --- |
| 单次 One-shot | 发送一次并返回网页回复 |
| 手动联机 | `0` 轮，只建立连接，不自动发送 |
| 指定轮次 | 运行 1–50 轮，默认受控上限为 20 轮 |
| 持续连接 | 围绕当前目标继续，直到完成、阻塞、重复、目标变化、超时或用户停止 |

### 6. 消息如何传递

桥接不会替你给网页模型补写“上下文说明”或执行指令。每条搬运消息只使用透明信封：

```text
【Codex → 网页端】
来源 Codex：当前 Codex 对话

【原完整内容】
这里是原始消息正文

【用户自己的提示词】
这里是用户主动补充的提示词；不需要时这一段为空且不会发送
```

网页回复回到 Codex 时使用对应标识：

```text
【网页端 → Codex 搬运】
来源网页：示例研究对话

【原完整内容】
这里是网页端的完整回复
```

原始内容、用户提示词和最终渲染消息会分别保存在本地发送记录中，便于跨进程去重、失败排查和安全重试。桥接消息在 100,000 字符以内保持原文，不再使用“前半段 + 后半段”的静默压缩；超过安全上限会直接失败并暂停，要求用户拆分消息。用户可以在 `bridge_send` 的 `user_prompt` 中主动提供附加提示词；默认没有附加提示词。

正常搬运必须使用插件的 `bridge_connect`、`bridge_send`、`bridge_receive` 流程，即使用户已经给出了固定网页 URL 或固定 Codex URL。不要用临时 WebSocket、CDP 或 DOM 脚本代替公共桥接工具，否则无法获得完整性校验、去重和失败暂停保护。

### 中断后由谁继续：持久化交接账本

每次已确认的双向搬运都会写入本地交接账本：方向、内容哈希、长度、网页消息的可见显示时间（网页提供时）、本地观察时间和交付状态。它不另存新的消息正文。

网页卡住、Codex/插件重启或某一端先停止后，直接说“检查桥接从哪里中断”；在你明确要求恢复已暂停连接时，插件也会先自动运行 `bridge_reconcile`，再决定是否允许恢复：

```text
网页最后一条晚于 Codex，且未确认交给 Codex
→ 下一条应由网页端发起

Codex 最后一条晚于网页端，且未确认交给网页端
→ 下一条应由 Codex 发起

最近一次 Codex → 网页端尚未得到稳定回复
→ 等待网页端；绝不自动重复发送
```

如果两端都存在未确认消息但时间相同、没有可读取的绑定 Codex 对话，或目标网页发生变化，结果会是暂停/低置信度，而不是猜测。判定只给出安全的下一发起方；恢复或重发仍必须由用户明确要求。

### 文件交接：任务产物自动随报告交付

在 Brain-Hand 模式中，文件是执行报告的一部分，不需要用户逐个点名。Bridge Goal 创建时会记录当前 Git 工作区基线；之后每次 `executor_report` 都会在发送报告前自动处理本任务新产生的安全文件：

```text
0 个新产物：只发送完整执行报告
1 个新产物：附到同一网页对话，再发送完整执行报告
2 个及以上新产物：自动生成 .codex-bridge/attachments/*.zip，附到同一网页对话，再发送完整执行报告
```

自动交付只包含“目标创建后才出现的 Git 改动”，并排除目标创建前已有改动、`.git`、`node_modules`、`.codex-bridge`、构建缓存和敏感路径（例如 `.env`、密钥/证书/凭据文件）。同一相对路径且 SHA-256 未变化时不会重复上传。每次最多 100 个源文件/500 MB；如果符合条件的任务产物无法完整打包或网页端没有确认附件，执行报告不会半截发送，连接会暂停。

`bridge_attachment_package` 与 `bridge_attachment_upload` 仍然保留给用户明确要求的临时/额外文件交接；它们的手工上传只附到编辑器，不会隐式发送聊天消息。

网页端文件反向交接仍需显式选择：先调用 `bridge_attachment_list` 查看当前网页对话中可见的下载项，再用 `bridge_attachment_download` 指定 `attachment_id`。文件只会保存到当前工作区的 `.codex-bridge/downloads/`（或用户指定的工作区内目录），完成后返回相对路径、大小和 SHA-256。下载目录无法受控、附件列表变化或下载未完成时，桥接会暂停，不会点击第二次或换标签页。

## OpenCode 用户配置

OpenCode 有两种使用层级，按需求选择即可。

### A. OpenCode 直接调用本地 MCP：最简单

把下面配置合并到 OpenCode 的 `opencode.jsonc`，将两个路径替换成真实绝对路径：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "codex-bridge": {
        "type": "local",
        "command": [
          "node",
          "C:/path/to/codex-bridge-toolkit/scripts/mcp_server.mjs"
        ],
        "cwd": "C:/path/to/your/project",
        "environment": {
          "CODEX_BRIDGE_EXECUTOR_PROVIDER": "opencode",
          "OPENCODE_SERVER_URL": "http://127.0.0.1:4096"
        }
      }
    }
  }
}
```

重启 OpenCode 后，在 OpenCode 对话中说：

```text
连接 ChatGPT 网页端，使用当前工作区，先建立连接，不要自动开始多轮。
```

这一层由 OpenCode 自己负责调用 MCP 工具和执行本地任务；不需要启动 `opencode serve`。

### B. 插件托管 OpenCode worker：自动 Brain-Hand

如果希望 Control Plane 创建并驱动独立 OpenCode 执行会话，先在项目工作区启动 OpenCode 的本地服务：

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

然后在桥接参数中选择：

```json
{
  "executor_provider": "opencode",
  "executor_endpoint": "http://127.0.0.1:4096",
  "executor_model": "provider/model",
  "executor_agent": "build"
}
```

`executor_model` 和 `executor_agent` 按你的 OpenCode 配置填写；没有需要时可以省略。OpenCode 没有被冒充为 Codex，也没有 Codex 原生 Goal API，所以这里的 Goal 是插件本地 Bridge Goal。

可复制模板见 [examples/opencode/](examples/opencode/)。OpenCode 的 MCP 和 server 配置以其[官方 MCP 文档](https://opencode.ai/v2/docs/mcp-servers)与[官方 Server API 文档](https://dev.opencode.ai/docs/server/)为准。

## 目前已经实现什么

| 能力 | 状态 | 边界 |
| --- | --- | --- |
| 多条 Codex / Pro 网页会话并行 | ✅ | 不同宿主上下文使用独立 worker；同一路由内保持串行 |
| ChatGPT Web / DeepSeek Web | ✅ | 可见 Chrome/Edge DOM/CDP；不使用私有网页接口 |
| Codex / OpenCode 并列宿主 | ✅ | Codex 使用 App Server；OpenCode 使用本地 MCP 或显式 server |
| 浏览器 Watchdog | ✅ | 检查登录、编辑器、发送按钮、生成超时、页面失联和选择器降级 |
| 目标与证据闭环 | ✅ | plan → execute → report → review；完成必须有证据 |
| 多网页会话 Swarm | ✅ 实验性 | 每个成员独立 worker、目标、Watchdog；失败时暂停整个组 |
| 中断归因与恢复建议 | ✅ | 比对网页/Codex 最新消息的显示或观察时间与持久化交接账本；只建议下一发起方，不自动重发 |
| ChatGPT 网页附件交接 | ✅ | Brain-Hand 任务产物自动 ZIP/同一对话交付；额外本地文件与网页下载仍需明确选择；失败即暂停 |
| 本地 GitHub 工作区 | ✅ 只读 | 连接时读取仓库、分支、HEAD、变更数量等摘要；不自动 pull/push/commit |
| 本地素材工具 | 🟡 | 可发现 Word/PPT/PDF 元数据；只读取用户明确选择的 Markdown/文本/CSV |
| Notion / Word / PPT 正文协同 | ⏳ | 本版本尚未提供正文适配器 |
| Computer Use 语义判断 | ⏳ | 当前 Watchdog 是规则化 CDP/DOM 观测，不是视觉模型 |
| DevSpace 专用适配 | ⏳ | 目前只报告通用 stdio MCP 兼容性 |

“检测降智”不能由浏览器规则可靠判断。当前实现会报告可观察的卡死、超时、页面失联和 UI 退化；遇到不确定状态就暂停，不会猜测后继续。

## 多会话和失败策略

一个网页标签页不是一个固定网页对话。用户可能在同一标签页内切换 ChatGPT/DeepSeek 会话，因此每次发送前都会再次验证：

- 浏览器实例、窗口和原始标签页；
- 网页模型域名；
- 网页对话 URL/标题指纹；
- 登录状态、编辑器和发送按钮；
- 最近一次消息是否已经消费。

如果发现标签页关闭、会话切换、网页模型不匹配、生成超时、重复消息或解析失败，连接会进入 `PAUSED`。插件只允许对原标签页做一次刷新恢复；恢复失败就停下来报告，绝不自动换标签页、创建新对话或重发不确定消息。

多个网页会话组共享同一个本地 Git 工作区摘要，但每个成员拥有独立的 worker、浏览器目标和 Watchdog。任何成员失败都会暂停组，修复原目标后再显式恢复。

## 面板是什么

```text
┌────────────────────┐   ··· ↔ ···   ┌────────────────────┐
│ 当前 Codex 对话     │  ──●──────▶  │ ChatGPT / DeepSeek  │
│ 当前目标 / 状态     │  ◀──●──────  │ 网页对话 / 状态      │
└────────────────────┘               └────────────────────┘
```

`bridge_panel` 是“状态可视化面板”：左边显示当前 Codex 对话或插件 worker，右边显示网页模型、浏览器目标和网页对话，虚线表示连接。它不会显示消息正文，不会提问，不会创建目标，也不会假装是 Codex Desktop 的未公开原生 UI 注入。

如果宿主支持 MCP UI 资源，面板会内嵌在当前对话；否则可以使用兼容模式打开本机回环面板。真正的官方原生 toolbar/panel 扩展点不由本插件假设。

## 工具包

| 工具包 | 常用入口 |
| --- | --- |
| Web LLM Bridge | `bridge_discover`、`bridge_connect`、`bridge_send`、`bridge_run` |
| Browser Watchdog | `browser_watchdog_scan`、`browser_watchdog_start` |
| GitHub Workspace | `github_workspace_status`、`github_workspace_bind` |
| Host Compatibility | `bridge_host_status` |
| Artifact Workspace | `artifact_workspace_status`、`artifact_workspace_read` |
| Web Session Swarm | `bridge_swarm_create`、`bridge_swarm_status`、`bridge_swarm_run` |
| Brain-Hand loop | `brain_plan`、`executor_report`、`brain_review`、`continue_task` |
| OpenCode executor | `executor_provider_list`、`codex_adapter_status`、`codex_thread_start` |
| Codex source read | `codex_source_thread_read`（只读读取明确提供的 `codex://threads/<id>`，不会绑定、执行或自动转发） |

普通用户不需要记工具名；直接在当前宿主对话里描述意图即可，例如：

```text
查看所有网页端连接
检查 ChatGPT 标签页是否卡住
扫描当前工作区里的 Word、PPT 和 PDF
创建 3 个网页会话并绑定同一个工作区
```

## 安全边界

包含：

- 可见 Chrome/Edge 自动化和本地 CDP；
- 用户手动登录；
- 目标校验、消息来源标记、去重和证据门禁；
- 跨进程路由状态与最近结构化事件；
- 失败即暂停的停止策略。

不包含：

- 密码、Cookie、Token、API Key、验证码收集；
- 私有 ChatGPT 接口、隐藏历史或隐藏思维链；
- 自动批准命令、自动换标签页、自动创建替代会话；
- 自动 pull、push、commit 或向 GitHub 写入；
- 把网页模型回复提升为用户授权。

## 仓库结构

```text
.codex-plugin/              插件清单
.mcp.json                   本地 stdio MCP 入口
scripts/mcp_server.mjs      MCP 服务与兼容路由
src/adapters/               ChatGPT/DeepSeek/Codex/OpenCode 适配器
src/control_plane/          路由、锁与跨进程 worker
src/toolkits/               Watchdog、GitHub、素材与宿主工具包
src/orchestration/          Swarm 状态与停止策略
examples/opencode/           OpenCode 配置模板
tests/                       协议、路由、适配器和压力测试
```

## 常见排障

### 找不到浏览器或要求登录

普通启动的 Edge 不能被事后接管。让插件自动打开专用 Edge，在那个可见窗口登录，再回到同一个对话说“登录好了，继续”。不要关闭专用配置，也不要把普通 Edge 的登录状态当成专用 Edge 的登录状态。

### 输入框或发送按钮失效

桥接只会在原标签页刷新一次并重新检查。成功就继续；失败则保留原目标并暂停。不会因为一次 UI 失效而重复创建标签页或重发消息。

如果网页消息发送失败，连接会进入“已暂停”，不会继续等待或读取网页回复。修复原标签页后说“登录好了，继续”或明确要求恢复；插件才会重新检查并允许重试。

### 中断后不知道该由谁继续

说“检查桥接从哪里中断”。桥接会读取原网页标签页最后一条可见助手消息、已绑定 Codex 对话/Worker 的最后一条助手消息，并与本地交接账本比对。它会报告“网页端继续”“Codex 继续”“等待网页回复”或“无法安全判断”，不会擅自重发。

### 需要把文件交给网页端，或取回网页端文件

正常 Brain-Hand 执行不需要点名：目标创建后产生的安全 Git 改动会在每份执行报告前自动附上；多个文件会自动 ZIP。目标创建前已有改动、敏感文件或缓存目录不会自动外发。需要额外的非任务文件时，再明确选择并用手工打包/上传工具。网页端下载必须先列出附件再选择一个 `attachment_id`；如果 ChatGPT UI 没有可识别的下载控件或浏览器不能把下载保存到工作区，插件会暂停并保留原网页标签页。

### 连接发错网页对话

立即说“暂停网页连接”。修正原标签页中的网页对话后，再明确要求恢复。连接不会自动猜测新标题。

ChatGPT 自定义 GPT 的会话地址（`/g/.../c/...`）也会按其中的会话 ID 校验；如果地址或会话发生变化，桥接会暂停，不会自动切换。

### 搬运另一个 Codex 对话

如果需要参考或搬运另一个 Codex 任务，请明确提供它的 `codex://threads/<id>` 地址。插件只读提取有界内容；它不会把另一个任务误当成当前 Codex Worker，也不会同步它的 Goal 或自动执行。需要转发给网页端时，必须由用户明确提出。

### Windows 下 Codex Worker 启动失败

插件默认通过 PATH 中的 `codex.cmd` 启动 App Server，而不是桌面版 `codex.exe`。如果 Codex CLI 不在 PATH，可设置 `CODEX_BRIDGE_CODEX_COMMAND` 指向可执行的 `codex.cmd` 或 `codex.ps1`，然后重启宿主。

### OpenCode 看不到 MCP

确认 OpenCode 配置中的 server 类型是 `local`、命令数组指向仓库里的 `scripts/mcp_server.mjs`，并且重启 OpenCode。托管执行场景再检查 `opencode serve`、端口和 `OPENCODE_SERVER_URL`。

### 更新后工具没有出现

重启 Codex/OpenCode，并新建宿主对话。旧对话可能缓存旧的 MCP 工具和 skill。

## 开发与验证

贡献者在仓库根目录运行：

```powershell
npm test
npm run check
git diff --check
```

当前发布版本：`0.8.0`。本次版本把仓库定位为“Codex Bridge Toolkit Series”，并加入 OpenCode 并列宿主适配、模块化工具包和多会话失败即停策略。

更多设计说明：

- [工具包系列设计](docs/toolkit-series.md)
- [OpenCode 配置模板](examples/opencode/README.md)
- [Codex 原生集成边界](docs/codex-native-integration.md)
- [English README](README.en.md)
