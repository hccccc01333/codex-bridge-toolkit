# Codex Luna ChatGPT Bridge

A protocol-driven local agent orchestration runtime that lets a selected visible web AI act as a planning brain while a Codex App Server worker executes tasks in the connected workspace.

The bridge uses Chrome DevTools Protocol against a user-visible Chrome or Edge window. It does not use the ChatGPT API, private endpoints, passwords, cookies, CAPTCHA bypasses, or hidden conversation history. Sign in manually in the dedicated browser profile.

## Features

- `brain_provider_list`: list installed web brain profiles
- `executor_provider_list`: list Codex executor providers, models, and local profile mappings
- `brain_plan`: ask the selected web brain for the next concrete task
- `executor_report`: send the executor's concise result to the selected web conversation
- `brain_review`: classify the result as continue, completed, blocked, or repeated
- `continue_task`: advance bounded rounds, with a default limit of 20 and a maximum of 50
- `run_round` / `run_until_stop`: execute the complete plan → Codex → report → review loop for one or bounded rounds
- Persistent `session_id` routing for multiple web brain tabs in one browser
- Provider-specific web adapter health checks with selector fallbacks
- Built-in ChatGPT Web and DeepSeek Web brain profiles, with a profile extension point for other web AI providers
- Selectable Codex executors: ChatGPT Luna by default, DeepSeek API with `deepseek-v4-pro`/`deepseek-v4-flash`, or the current local Codex configuration
- Lightweight Control Plane routes with compact status and structured events
- Codex Adapter tools for starting, resuming, reading, and sending turns to a real Codex App Server thread
- Task IR and bounded executor-report compilation for brain prompts
- Evidence-first completion checks

## Multi-tab routing

Each bridge session owns one browser tab and one `brain_provider`. The bridge records the DevTools `targetId` as the primary tab identity and uses the provider's conversation URL format for recovery and validation. Reuse a `session_id` when multiple tool calls should coordinate through the same tab; use a distinct `session_id` for independent work.

Create or inspect sessions with `chatgpt_browser_session_create` and `chatgpt_browser_session_list`. Include the relevant `session_id` in every browser and brain-hand call. The default session remains available for compatibility.

## Setup

1. Install the plugin in Codex through the plugin manager or a configured marketplace.
2. Start Chrome or Edge with remote debugging enabled, or use `chatgpt_browser_launch`.
3. Choose a provider: omit `brain_provider` to use the default ChatGPT Web, or set it to `deepseek` for DeepSeek Web. Then open the selected web brain and sign in manually.
4. Use `brain_browser_open` with the same `session_id`; the session remembers the selected provider. Select a conversation by title, ID, or provider URL.
5. Start the brain-hand loop with `run_round` or `run_until_stop`.

The MCP server entrypoint is `scripts/mcp_server.mjs`. Session routing metadata is stored in the user's application data directory and is not part of this repository.

## Control Plane routes

For multi-agent use, a route is the stable mapping between one executor thread and one brain session:

```text
route_id
  ├── brain_provider  (chatgpt, deepseek, or a future provider profile)
  ├── executor_provider / executor_model / executor_profile
  │     (chatgpt_luna, deepseek_api Pro/Flash, or codex_current)
  ├── codex_thread_id   (Codex Adapter worker identity)
  └── session_id
        ├── browser target/tab
        └── ChatGPT conversation
```

The `bridge_route_*` tools create, bind, inspect, pause, resume, and append structured events to routes. Brain-hand, browser, and Codex worker actions with the same `route_id` are serialized by a per-route queue. A SQLite-backed lease extends that serialization across separate MCP processes; route snapshots remain under `%LOCALAPPDATA%\\CodexChatGPTBridge\\routes`, with the lease database at `%LOCALAPPDATA%\\CodexChatGPTBridge\\control-plane.sqlite`.

The Codex Adapter uses the public Codex App Server JSON-RPC protocol over stdio. `codex_thread_start`, `codex_thread_turn`, and `codex_thread_read` bind real worker threads to routes. If the App Server cannot be started, the bridge returns an explicit adapter error; it never fabricates a thread or auto-approves worker requests.

For users whose local Codex configuration already points to DeepSeek API, choose `executor_provider: "codex_current"`. This launches the worker without a forced `-p` profile, so Codex inherits the user's local provider, model, and authentication configuration. Set `executor_model` only when the route should pin a known model, or set `executor_profile` when the user's existing Codex profile has a custom name. The bridge does not read or copy the profile's API key.

### Brain/executor combinations

The web brain and Codex executor are independent route choices. The default is ChatGPT Web → ChatGPT Luna. For example:

```json
{
  "route_id": "deepseek-brain-luna",
  "brain_provider": "deepseek",
  "executor_provider": "chatgpt_luna"
}
```

```json
{
  "route_id": "chatgpt-brain-deepseek-flash",
  "brain_provider": "chatgpt",
  "executor_provider": "deepseek_api",
  "executor_model": "deepseek-v4-flash"
}
```

The third supported pattern is DeepSeek Web → DeepSeek API; select `brain_provider: "deepseek"`, `executor_provider: "deepseek_api"`, and either `deepseek-v4-pro` or `deepseek-v4-flash`. The bridge only selects local Codex profiles (`openai`, `deepseek-pro`, or `deepseek-flash`); it never reads, stores, or forwards API keys. A user who selects DeepSeek API must configure the corresponding Codex profile in their own environment. DeepSeek documents an OpenAI-compatible API and the Pro/Flash model names in its [official API documentation](https://api-docs.deepseek.com/api/list-models).

When the route should follow an existing local DeepSeek setup rather than the bridge's conventional profile names, use:

```json
{
  "route_id": "existing-deepseek-codex",
  "brain_provider": "chatgpt",
  "executor_provider": "codex_current",
  "executor_model": "deepseek-v4-flash"
}
```

If the existing Codex thread ID is known, pass it as `codex_thread_id` so `codex_thread_start` resumes that thread through the inherited configuration. The bridge cannot discover or take over an arbitrary desktop window on Windows; it uses the public App Server boundary and preserves the selected model/provider instead of silently switching to Luna.

## Runtime Runner

`run_round` closes one route-bound cycle: it obtains the current plan (or asks the selected web brain for the first one), sends the task to the Codex worker, compiles a bounded executor report, asks the planning brain for review, records TASK/RESULT/EVIDENCE/REVIEW events, and applies completion, blocking, repetition, and max-round stop policy. `run_until_stop` repeats this flow up to the configured maximum. Codex approval or interaction requests stop the run explicitly; the runner never auto-approves them.

## Web Brain Providers

The registry currently includes [ChatGPT Web](https://chatgpt.com/) and [DeepSeek Web](https://chat.deepseek.com/). ChatGPT Web is the default. Use `brain_provider_list` to inspect the installed profiles and their selection hints. Use `executor_provider_list` to inspect the Codex-side executor choices. The generic browser aliases (`brain_browser_*`) accept `brain_provider` and keep the older `chatgpt_browser_*` tool names working for compatibility.

For a DeepSeek session, create it once with `brain_provider: "deepseek"`; later calls using that `session_id` inherit DeepSeek unless another provider is explicitly selected. Switching a session's provider clears its browser target and conversation metadata, so the new provider can be signed in and selected safely.

Each provider profile owns only web-specific details: start URL, allowed host, conversation URL prefixes, visible input/send selectors, assistant-message selectors, and health-check terms. The Brain protocol, Control Plane routes, Codex worker, evidence gate, and Runtime Runner are provider-neutral. A new web model requires a reviewed profile and selector tests; the bridge does not guess private endpoints or claim that arbitrary sites work automatically.

Cross-process route serialization requires a Node runtime that provides `node:sqlite`. When that capability is unavailable, the bridge remains usable and exposes `process-only` serialization in route status, but it does not claim a cross-process lock guarantee.

## Protocol and evidence

`scripts/protocol.mjs` defines the first internal protocol layer. It compiles plan inputs into a bounded Task IR, limits report fields before they are sent to the selected web brain, and requires at least one structured test or evidence item before a review can remain `completed`. This is a foundation for future provider-specific prompt compilers, trace/replay, and benchmark evaluation.

## Validation

```powershell
npm test
npm run check
```

The test suite covers Task IR and report bounds, evidence-first completion, repeated detection, max-round stopping, session/route isolation, same-route serialization, cross-process route leases, conversation-ID recovery, paused-route refusal, the Codex Adapter protocol boundary, and the Runtime Runner round loop.

The plugin manifest is under `.codex-plugin/plugin.json` and the MCP server configuration is `.mcp.json`.
