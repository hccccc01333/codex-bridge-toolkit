# Codex 原生集成边界

## 当前结论

这个插件可以通过官方 `codex app-server` 驱动一个真实的 Codex Worker，并把 `bridge_goal_create` 的结果写入这个 Worker 的原生 Goal。App Server 公开了：

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

因此 Brain-Hand 的持续目标现在不只是 Bridge Task 元数据：在 Worker 已创建后，插件会调用 `thread/goal/set`，让 Codex 原生 Goal 与桥接目标同步。

官方参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

仍需区分两个 thread：

1. **插件管理的 Codex Worker thread**：插件可以创建/恢复它，并可靠地写入原生 Goal。
2. **用户眼前的 Codex Desktop 对话 thread**：当前 MCP 宿主没有把这个 thread ID 传给插件，因此插件不会猜测或修改它的隐藏状态。

这意味着“原生 Goal 已同步”代表 Worker thread 已同步，不代表插件能够修改当前 Desktop 对话顶部的 Goal。目标不确定、Worker 启动失败或目标写入失败时，插件会返回 `pending`/错误状态，不会伪造成功。

## `bridge_goal_create` 的同步流程

```text
Codex 对话向用户询问目标
        ↓
bridge_goal_create
        ↓
编译并保存 Bridge Goal
        ↓
bounded / continuous 模式：创建或恢复 Codex Worker
        ↓
thread/goal/set
        ↓
原生 Codex Goal 与 Bridge Goal 同步
```

单次 `one_shot` 连接不会为了发送一次网页消息额外启动 Worker；如果该路由已经有 Worker，则仍会同步 Goal。开始 `bridge_run` 时，插件会再次执行同步，作为重试和一致性检查。

## 目标产品模型

```text
当前 Codex Task
      │
      ├── user answer → bridge goal（当前桥接目标）
      ├── relay mode：one-shot / manual / bounded / continuous
      └── bridge binding
              │
              └── Web conversation
```

面板只显示连接状态，不显示消息、不提问、不创建目标。`goal_source: codex_user_answer` 表示目标来自连接成功后 Codex 向用户提出的问题；`native_goal.synced` 表示 Codex Worker 的原生 Goal 已写入。

## 原生 UI 的实现位置

如果要真正做到“直接加入 Codex 原生框架”，需要选择以下路线之一：

1. Codex 官方增加插件 UI contribution API，然后这个插件注册 `ui.panel` 和 Desktop thread context provider。
2. Fork `openai/codex`，在目标宿主（TUI 或拥有 UI 源码的客户端）加入 Bridge panel，再把本仓库的 `src/bridge/` 和 `src/adapters/` 作为运行层。
3. 使用 `codex app-server` 自己做一个 Codex 富客户端。它不是官方 Desktop 内嵌，但可以拥有完整的原生双栏 UI；当前插件已经采用 App Server 作为 Worker 和原生 Goal 的连接层。

第三种路线能最快验证产品；第一种路线最符合“官方 Codex 内置”，但依赖上游 API；第二种路线需要维护 Codex Fork。

## 双栏 UI 目标

```text
┌──────────────────────┐    ⋯⋯⋯  ↔  ⋯⋯⋯    ┌──────────────────────┐
│ Codex 对话           │  ───────────────▶   │ Web 对话             │
│ 连接状态             │    destination      │ ChatGPT / DeepSeek   │
│ 当前 Bridge Task     │  ◀───────────────    │ 连接状态             │
└──────────────────────┘                     └──────────────────────┘
```

面板只显示两端连接状态、网页模型、浏览器、窗口、标签页和网页对话绑定。消息和目标都留在 Codex 对话流程中，不在面板内重复渲染。
