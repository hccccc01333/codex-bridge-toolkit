# Codex Luna ChatGPT Bridge

A protocol-driven Codex plugin that lets visible ChatGPT Web act as a planning brain while a Codex App Server worker executes tasks in the connected workspace.

The bridge uses Chrome DevTools Protocol against a user-visible Chrome or Edge window. It does not use the ChatGPT API, private endpoints, passwords, cookies, CAPTCHA bypasses, or hidden conversation history. Sign in manually in the dedicated browser profile.

## Features

- `brain_plan`: ask ChatGPT Web for the next concrete task
- `executor_report`: send Luna's concise execution result to the web conversation
- `brain_review`: classify the result as continue, completed, blocked, or repeated
- `continue_task`: advance bounded rounds, with a default limit of 20 and a maximum of 50
- Persistent `session_id` routing for multiple ChatGPT tabs in one browser
- ChatGPT Web adapter health checks with selector fallbacks
- Lightweight Control Plane routes with compact status and structured events
- Codex Adapter tools for starting, resuming, reading, and sending turns to a real Codex App Server thread
- Task IR and bounded executor-report compilation for brain prompts
- Evidence-first completion checks

## Multi-tab routing

Each bridge session owns one browser tab. The bridge records the DevTools `targetId` as the primary tab identity and uses the ChatGPT conversation ID from `/c/<conversation-id>` URLs for recovery and validation. Reuse a `session_id` when multiple tool calls should coordinate through the same tab; use a distinct `session_id` for independent work.

Create or inspect sessions with `chatgpt_browser_session_create` and `chatgpt_browser_session_list`. Include the relevant `session_id` in every browser and brain-hand call. The default session remains available for compatibility.

## Setup

1. Install the plugin in Codex through the plugin manager or a configured marketplace.
2. Start Chrome or Edge with remote debugging enabled, or use `chatgpt_browser_launch`.
3. Open ChatGPT Web and sign in manually.
4. Use `chatgpt_browser_open`, then select a conversation by title, ID, or URL.
5. Start the brain-hand loop with `brain_plan`.

The MCP server entrypoint is `scripts/mcp_server.mjs`. Session routing metadata is stored in the user's application data directory and is not part of this repository.

## Control Plane routes

For multi-agent use, a route is the stable mapping between one executor thread and one brain session:

```text
route_id
  ├── codex_thread_id   (Codex Adapter worker identity)
  └── session_id
        ├── browser target/tab
        └── ChatGPT conversation
```

The `bridge_route_*` tools create, bind, inspect, pause, resume, and append structured events to routes. Brain-hand, browser, and Codex worker actions with the same `route_id` are serialized by a per-route queue. A SQLite-backed lease extends that serialization across separate MCP processes; route snapshots remain under `%LOCALAPPDATA%\\CodexChatGPTBridge\\routes`, with the lease database at `%LOCALAPPDATA%\\CodexChatGPTBridge\\control-plane.sqlite`.

The Codex Adapter uses the public Codex App Server JSON-RPC protocol over stdio. `codex_thread_start`, `codex_thread_turn`, and `codex_thread_read` bind real worker threads to routes. If the App Server cannot be started, the bridge returns an explicit adapter error; it never fabricates a thread or auto-approves worker requests.

## Protocol and evidence

`scripts/protocol.mjs` defines the first internal protocol layer. It compiles plan inputs into a bounded Task IR, limits report fields before they are sent to ChatGPT Web, and requires at least one structured test or evidence item before a review can remain `completed`. This is a foundation for future provider-specific prompt compilers, trace/replay, and benchmark evaluation.

## Validation

```powershell
npm test
npm run check
```

The test suite covers Task IR and report bounds, evidence-first completion, repeated detection, max-round stopping, session/route isolation, same-route serialization, cross-process route leases, conversation-ID recovery, paused-route refusal, and the Codex Adapter protocol boundary.

The plugin manifest is under `.codex-plugin/plugin.json` and the MCP server configuration is `.mcp.json`.
