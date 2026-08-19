# Codex Luna ChatGPT Bridge

A Codex plugin that lets visible ChatGPT Web act as the planning brain while Codex Luna executes work in the connected workspace.

The bridge uses Chrome DevTools Protocol against a user-visible Chrome or Edge window. It does not use the ChatGPT API, private endpoints, passwords, cookies, CAPTCHA bypasses, or hidden conversation history. Sign in manually in the dedicated browser profile.

## Features

- `brain_plan`: ask ChatGPT Web for the next concrete task
- `executor_report`: send Luna's concise execution result to the web conversation
- `brain_review`: classify the result as continue, completed, blocked, or repeated
- `continue_task`: advance bounded rounds, with a default limit of 20 and a maximum of 50
- Persistent `session_id` routing for multiple ChatGPT tabs in one browser
- Lightweight Control Plane routes with compact status and structured events
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
  ├── codex_thread_id   (metadata; no automatic Codex App Server control yet)
  └── session_id
        ├── browser target/tab
        └── ChatGPT conversation
```

The `bridge_route_*` tools create, bind, inspect, pause, resume, and append structured events to routes. Brain-hand and browser actions with the same `route_id` are serialized by a per-route queue. Route state is compact and stored under `%LOCALAPPDATA%\\CodexChatGPTBridge\\routes`; full ChatGPT and Codex histories remain in their respective agents rather than in a central conversation.

The current Control Plane is deliberately metadata-first: it does not pretend to drive Codex Thread turns or to run an autonomous worker. A future Codex adapter can use `codex_thread_id` and the route event protocol without changing the ChatGPT Web adapter.

## Protocol and evidence

`scripts/protocol.mjs` defines the first internal protocol layer. It compiles plan inputs into a bounded Task IR, limits report fields before they are sent to ChatGPT Web, and requires at least one structured test or evidence item before a review can remain `completed`. This is a foundation for future provider-specific prompt compilers, trace/replay, and benchmark evaluation.

## Control Plane routes

For multi-agent use, a route is the stable mapping between one executor thread and one brain session:

```text
route_id
  ├── codex_thread_id   (metadata; no automatic Codex App Server control yet)
  └── session_id
        ├── browser target/tab
        └── ChatGPT conversation
```

The `bridge_route_*` tools create, bind, inspect, pause, resume, and append structured events to routes. Brain-hand and browser actions with the same `route_id` are serialized by a per-route queue. Route state is compact and stored under `%LOCALAPPDATA%\\CodexChatGPTBridge\\routes`; full ChatGPT and Codex histories remain in their respective agents rather than in a central conversation.

The current Control Plane is deliberately metadata-first: it does not pretend to drive Codex Thread turns or to run an autonomous worker. A future Codex adapter can use `codex_thread_id` and the route event protocol without changing the ChatGPT Web adapter.

## Protocol and evidence

`scripts/protocol.mjs` defines the first internal protocol layer. It compiles plan inputs into a bounded Task IR, limits report fields before they are sent to ChatGPT Web, and requires at least one structured test or evidence item before a review can remain `completed`. This is a foundation for future provider-specific prompt compilers, trace/replay, and benchmark evaluation.

## Validation

```powershell
node --check scripts/mcp_server.mjs
```

The plugin manifest is under `.codex-plugin/plugin.json` and the MCP server configuration is `.mcp.json`.
