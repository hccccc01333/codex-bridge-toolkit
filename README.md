# Codex Luna ChatGPT Bridge

A local Codex plugin that lets visible ChatGPT Web act as the planning brain while Codex Luna executes work locally.

The bridge uses Chrome DevTools Protocol against a user-visible Chrome or Edge window. It does not use the ChatGPT API, private endpoints, passwords, cookies, CAPTCHA bypasses, or hidden conversation history. Sign in manually in the dedicated browser profile.

## Features

- `brain_plan`: ask ChatGPT Web for the next concrete task
- `executor_report`: send Luna's concise execution result to the web conversation
- `brain_review`: classify the result as continue, completed, blocked, or repeated
- `continue_task`: advance bounded rounds, with a default limit of 20 and a maximum of 50
- Persistent `session_id` routing for multiple ChatGPT tabs in one browser
- A/B can share one session; an independent task C uses another session

## Multi-tab routing

Each bridge session owns one browser tab. The bridge records the DevTools `targetId` as the primary tab identity and uses the ChatGPT conversation ID from `/c/<conversation-id>` URLs for recovery and validation.

Typical setup:

```text
A executor + B relay: session_id = task-a
C independent task:   session_id = task-c
```

Create or inspect sessions with `chatgpt_browser_session_create` and `chatgpt_browser_session_list`. Include the same `session_id` in every browser and brain-hand call. The default session remains available for compatibility.

## Local setup

1. Install the plugin in Codex from your local marketplace.
2. Start Chrome or Edge with remote debugging enabled, or use `chatgpt_browser_launch`.
3. Open ChatGPT Web and sign in manually.
4. Use `chatgpt_browser_open`, then select a conversation by title, ID, or URL.
5. Start the brain-hand loop with `brain_plan`.

The MCP server entrypoint is `scripts/mcp_server.mjs`. Session routing metadata is stored locally under `%LOCALAPPDATA%\\CodexChatGPTBridge\\sessions` and is not part of this repository.

## Validation

```powershell
node --check scripts/mcp_server.mjs
```

The plugin manifest is under `.codex-plugin/plugin.json` and the MCP server configuration is `.mcp.json`.
