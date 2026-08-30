# 🧰 Codex Bridge Toolkit Series

> Let a web LLM plan and review while Codex or OpenCode executes in the local workspace—with visible browser automation and local MCP only.

**Default language: [中文（默认）](README.md) · English**

**Repository:** [hccccc01333/codex-bridge-toolkit](https://github.com/hccccc01333/codex-bridge-toolkit)

![Node.js](https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)
![Browser](https://img.shields.io/badge/Chrome%20%2F%20Edge-visible%20CDP-4285F4?logo=googlechrome&logoColor=white)
![Local-first](https://img.shields.io/badge/local--first-10b981)
![Version](https://img.shields.io/badge/version-0.8.0-2563eb)

## In one sentence

This is a “web brain ↔ local executor” bridge toolkit:

```text
ChatGPT Web / DeepSeek Web
          │ planning, questions, review
          ▼
       Bridge Control Plane
          │                 │
          ▼                 ▼
     Codex Worker       OpenCode Worker
          │                 │
          └────────┬────────┘
                   ▼
        local workspace, tests, evidence
```

Users talk only in the current host conversation. The toolkit discovers visible browser connections, binds a web conversation, relays explicit messages, persists link state, watches browser health, and pauses when the destination is uncertain.

> This is not the ChatGPT API, a cookie scraper, or a password collector. The browser remains visible and the user signs in manually.

## Choose your local host

| Local host | Best bridge path | Key point |
| --- | --- | --- |
| Codex Desktop / CLI | ChatGPT Web or DeepSeek Web ↔ Codex | Uses a Codex App Server worker and can synchronize the toolkit-managed native Goal |
| OpenCode | ChatGPT Web or DeepSeek Web ↔ OpenCode | OpenCode can load this plugin as local stdio MCP; start `opencode serve` only for toolkit-managed execution |
| Other MCP host | Web model ↔ current host | Standard stdio MCP is supported; dedicated execution capability is reported per host |

Codex and OpenCode are parallel hosts. They do not share hidden host sessions, and OpenCode is not disguised as Codex. Web adapters, browser verification, the Control Plane, watchdogs, and stop policies are shared; executor host adapters are separate.

## Start in five minutes

### 1. Install

Install the plugin from the Codex plugin marketplace, restart Codex, and create a new conversation.

For repository development:

```powershell
git clone https://github.com/hccccc01333/codex-bridge-toolkit.git
cd codex-bridge-toolkit
npm test
npm run check
```

End users do not need to start `scripts/mcp_server.mjs` manually or enter `session_id`, `targetId`, `route_id`, or a DevTools port.

### 2. Connect a web model

In the new Codex conversation, say:

```text
Connect to ChatGPT Web.
```

Or:

```text
Connect to DeepSeek Web.
```

The bridge scans debuggable browsers and presents the hierarchy browser → window → tab → web conversation in human-readable terms. If no debuggable browser is available, it starts a dedicated persistent Edge profile named `CodexBridgeEdge` and opens the provider page.

### 3. Sign in once

Sign in manually in the visible Edge window, then return to the same Codex conversation and say:

```text
I am logged in. Continue.
```

The toolkit never collects passwords, cookies, tokens, or CAPTCHAs. The dedicated profile is reused for later links.

### 4. Let the toolkit create the goal

After the connection is healthy, the toolkit asks in the current host conversation:

```text
What do you want to accomplish?
```

Answer with one concrete goal:

```text
Fix all failing tests in the current project and report changes, tests, and evidence after every round.
```

The answer becomes a Bridge Goal. For bounded or continuous Brain-Hand runs, the Codex adapter also attempts to synchronize the goal to the managed Codex Worker native Goal; only `native_goal.synced: true` means that synchronization succeeded. The panel only visualizes status—it does not ask questions or create goals.

### 5. Choose a relay mode

```text
One-shot: ask ChatGPT this architecture question and return its opinion.
Manual link: connect to DeepSeek, but do not send automatically.
Bounded: use ChatGPT for planning and review for up to 10 rounds.
Continuous: continue the current goal until complete, blocked, or stopped.
```

| Mode | Meaning |
| --- | --- |
| One-shot | Send once and return the visible web reply |
| Manual link | `0` rounds: connect without automatic sending |
| Bounded rounds | Run 1–50 controlled rounds; the default bounded limit is 20 |
| Continuous | Continue the current goal until completion, blocking, repetition, destination change, timeout, or user stop |

### 6. Message envelope

The bridge does not invent context notices or execution instructions for either model. Each relayed message uses a transparent envelope:

```text
【Codex → 网页端】
来源 Codex：当前 Codex 对话

【原完整内容】
The original message body

【用户自己的提示词】
An optional user-authored addition; this section is omitted when empty
```

When a web reply returns to Codex, it uses the matching marker:

```text
【网页端 → Codex 搬运】
来源网页：农场比赛 - 农场codex

【原完整内容】
The complete web reply
```

Original content, the optional user prompt, and the rendered message are stored separately in the local delivery ledger. Bridge messages are lossless up to the explicit 100,000-character safety limit; there is no silent head/tail compression. Above that limit the bridge fails closed and asks the user to split the message. Use `user_prompt` in `bridge_send` only when the user explicitly supplies an addition; it defaults to empty.

Normal relaying must use the public `bridge_connect`, `bridge_send`, and `bridge_receive` flow, even when the user provides a fixed web URL or fixed Codex URL. Do not replace it with an ad-hoc WebSocket, CDP, or DOM script; those paths cannot provide the bridge's completeness, deduplication, and fail-closed guarantees.

### Recovery after an interruption: durable handoffs

Every confirmed relay writes a local handoff record: direction, content hash, length, the visible web message timestamp when the page exposes one, local observation time, and delivery state. It does not store another copy of the message body.

After a browser, Codex, or plugin interruption, ask the bridge to check where the link stopped. The bridge also runs `bridge_reconcile` before reopening a paused link after an explicit user recovery request. It compares the last visible web peer, the last readable bound Codex peer, and the durable handoff ledger:

```text
Newer unacknowledged web message → web initiates next
Newer unacknowledged Codex message → Codex initiates next
Latest Codex → web send has no stable reply → wait for web; never resend automatically
```

When timestamps tie, the Codex peer cannot be read, or the destination changed, the result is paused/low-confidence instead of a guess. Reconciliation recommends a safe next initiator only; resuming or sending remains an explicit user action.

### File handoff: ZIP, upload, and download

To give several local deliverables to a ChatGPT web conversation, use three explicit steps:

```text
1. bridge_attachment_package: package named workspace files into .codex-bridge/attachments/*.zip
2. bridge_attachment_upload: add that ZIP (or explicitly selected individual files) to the verified web composer
3. bridge_send: explicitly send the accompanying chat message
```

Upload only adds files to the composer; it never sends a chat message implicitly. The tool accepts regular files explicitly named inside the workspace, up to 100 files / 500 MB, retains generated ZIP files, and never overwrites an existing archive.

For a web-to-Codex file handoff, call `bridge_attachment_list` first, then choose one `attachment_id` with `bridge_attachment_download`. The file is saved only under `.codex-bridge/downloads/` in the active workspace (or another user-selected workspace-relative directory) and returns its relative path, size, and SHA-256. If the browser cannot use a controlled download directory, the visible attachment changes, or completion cannot be verified, the bridge pauses; it never clicks again or switches tabs.

## OpenCode setup

OpenCode has two integration levels.

### A. OpenCode calls the local MCP: simplest path

Merge this into OpenCode's `opencode.jsonc` and replace both absolute paths:

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

Restart OpenCode and say:

```text
Connect to ChatGPT Web using the current workspace. Establish the link, but do not start a multi-round run.
```

In this mode OpenCode itself calls MCP tools and executes the local task. You do not need `opencode serve`.

### B. Toolkit-managed OpenCode worker: automatic Brain-Hand

To let the Control Plane create and drive an independent OpenCode execution session, start the local OpenCode server from the project workspace:

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

Then select:

```json
{
  "executor_provider": "opencode",
  "executor_endpoint": "http://127.0.0.1:4096",
  "executor_model": "provider/model",
  "executor_agent": "build"
}
```

Fill `executor_model` and `executor_agent` according to your OpenCode configuration; omit them when not needed. OpenCode is not presented as Codex, and it has no Codex native Goal API, so this flow uses the toolkit's local Bridge Goal.

See [examples/opencode/](examples/opencode/) for a copyable template. Use OpenCode's [official MCP documentation](https://opencode.ai/v2/docs/mcp-servers) and [official Server API documentation](https://dev.opencode.ai/docs/server/) for its host-side configuration.

## Implemented capability

| Capability | Status | Boundary |
| --- | --- | --- |
| Parallel Codex / Pro web sessions | ✅ | Separate host contexts get isolated workers; one route remains serialized |
| ChatGPT Web / DeepSeek Web | ✅ | Visible Chrome/Edge DOM/CDP; no private web endpoint |
| Parallel Codex / OpenCode hosts | ✅ | Codex App Server; OpenCode local MCP or explicit local server |
| Browser Watchdog | ✅ | Login, composer, send button, generation timeout, disconnect, and selector degradation |
| Goal and evidence loop | ✅ | plan → execute → report → review; completion requires evidence |
| Multi-web-session Swarm | ✅ experimental | Independent worker, target, and watchdog per member; group pauses on failure |
| Interruption attribution and recovery advice | ✅ | Compares the latest web/Codex message timestamps with durable handoffs; recommends the next initiator only, never auto-resends |
| ChatGPT web file handoff | ✅ | Explicit ZIP packaging, same-conversation upload, and visible attachment selection for download; failure pauses |
| Local GitHub workspace | ✅ read-only | Captures repository, branch, HEAD, and change-count summaries; no automatic pull/push/commit |
| Local artifact tools | 🟡 | Discovers Word/PPT/PDF metadata; reads explicitly selected Markdown/text/CSV only |
| Notion / Word / PPT body collaboration | ⏳ | Body adapters are not included in this release |
| Computer Use semantic checks | ⏳ | Current Watchdog is rule-based CDP/DOM observation, not a vision model |
| Dedicated DevSpace adapter | ⏳ | Generic stdio MCP compatibility is reported, but no dedicated adapter is claimed |

Semantic “model degradation” is not reliably inferable from browser rules. The current implementation reports observable hangs, timeouts, disconnects, and UI degradation; uncertainty causes a pause rather than a guess.

## Multiple sessions and fail-closed behavior

A browser tab is not a fixed web conversation. A user can switch conversations inside the same ChatGPT or DeepSeek tab, so every send re-verifies:

- browser instance, window, and original tab;
- provider domain;
- conversation URL/title fingerprint;
- login state, composer, and send control;
- whether the previous message was already consumed.

If the tab closes, the conversation changes, the provider is wrong, generation times out, a duplicate is detected, or parsing fails, the link enters `PAUSED`. The bridge allows one refresh of the original tab; if recovery fails, it preserves the target and stops. It never silently switches tabs, creates a replacement conversation, or resends an uncertain prompt.

A web-session Swarm shares one compact local Git workspace summary, but each member owns an independent worker, browser target, and watchdog. One member failure pauses the group until the original target is repaired and the user explicitly resumes it.

## The status panel

```text
┌────────────────────┐   ··· ↔ ···   ┌────────────────────┐
│ Current Codex task  │  ──●──────▶  │ ChatGPT / DeepSeek  │
│ Goal / status       │  ◀──●──────  │ Web chat / status    │
└────────────────────┘               └────────────────────┘
```

`bridge_panel` is a status visualization: Codex or the managed worker on the left, the selected provider/browser/tab/conversation on the right, and a dashed link between them. It does not show message bodies, ask questions, create goals, or pretend to be an undocumented native Codex Desktop injection.

Hosts with MCP UI resources can render it in the current conversation. Other hosts can use the compatibility loopback panel. An official native toolbar/panel extension point is not assumed by this repository.

## Toolkit map

| Toolkit | Useful entry points |
| --- | --- |
| Web LLM Bridge | `bridge_discover`, `bridge_connect`, `bridge_send`, `bridge_run` |
| Browser Watchdog | `browser_watchdog_scan`, `browser_watchdog_start` |
| GitHub Workspace | `github_workspace_status`, `github_workspace_bind` |
| Host Compatibility | `bridge_host_status` |
| Artifact Workspace | `artifact_workspace_status`, `artifact_workspace_read` |
| Web Session Swarm | `bridge_swarm_create`, `bridge_swarm_status`, `bridge_swarm_run` |
| Brain-Hand loop | `brain_plan`, `executor_report`, `brain_review`, `continue_task` |
| OpenCode executor | `executor_provider_list`, `codex_adapter_status`, `codex_thread_start` |
| Codex source read | `codex_source_thread_read` (bounded read-only access to an explicit `codex://threads/<id>`; never binds, executes, or forwards automatically) |

Most users only need natural-language requests in the current host conversation:

```text
Show all web links
Check whether the ChatGPT tab is stuck
Scan this workspace for Word, PPT, and PDF assets
Create three web sessions bound to this workspace
```

## Safety boundary

Included:

- visible Chrome/Edge automation and localhost CDP;
- manual user sign-in;
- destination verification, origin labels, deduplication, and evidence gates;
- persisted cross-process route state and recent structured events;
- fail-closed stop policies.

Not included:

- password, cookie, token, API-key, or CAPTCHA collection;
- private ChatGPT endpoints, hidden history, or hidden chain-of-thought;
- auto-approved commands, silent tab replacement, or replacement conversations;
- automatic pull, push, commit, or GitHub writes;
- treating a web-model reply as user authorization.

## Repository map

```text
.codex-plugin/              plugin manifest
.mcp.json                   local stdio MCP entry
scripts/mcp_server.mjs      MCP server and compatibility routing
src/adapters/               ChatGPT/DeepSeek/Codex/OpenCode adapters
src/control_plane/          routes, leases, and cross-process workers
src/toolkits/               Watchdog, GitHub, artifact, and host toolkits
src/orchestration/          Swarm state and stop policies
examples/opencode/           OpenCode configuration template
tests/                       protocol, route, adapter, and pressure tests
```

## Troubleshooting

### No browser or login required

A normally launched Edge cannot be attached after the fact. Let the bridge start the dedicated Edge profile, sign in in that visible window, and say “I am logged in. Continue.” Do not confuse the dedicated profile with your ordinary Edge login.

### Composer or send button disappeared

The bridge refreshes the original tab once and checks again. If recovery fails, it keeps the original target and pauses. It does not create another tab or resend the prompt.

If web delivery fails, the link enters `PAUSED`; it does not continue waiting for or reading a web reply. Repair the original tab, then explicitly resume so the bridge can re-check the destination and retry safely.

### It is unclear which side should continue after an interruption

Ask the bridge to check where the link stopped. It compares the last visible assistant message in the original web tab, the last assistant message in the bound Codex conversation/worker when readable, and the local handoff ledger. It reports `web initiates next`, `Codex initiates next`, `wait for web`, or `cannot determine safely`; it never resends on its own.

### Files need to go to or come from the web chat

Do not ask the bridge to scan a directory. Explicitly select files, package when needed, upload into the current composer, and then explicitly send the message. For a web download, list visible attachments first and select one `attachment_id`. If the provider UI lacks a recognized download control or the browser cannot save inside the workspace, the bridge pauses and preserves the original tab.

### The message would go to the wrong web conversation

Say “Pause the web link,” repair the original tab's visible conversation, and explicitly resume. The bridge does not guess a new title.

ChatGPT custom GPT URLs (`/g/.../c/...`) are also checked by their conversation ID. If the URL or conversation changes, the link pauses instead of switching automatically.

### Bringing in another Codex conversation

When you explicitly provide a `codex://threads/<id>` URL for reference or transfer, the bridge reads bounded content only. It does not treat that other task as the current Codex Worker, synchronize its Goal, or execute it. Forwarding it to a web model still requires an explicit user request.

### Codex Worker fails to start on Windows

The bridge starts App Server through `codex.cmd` on PATH rather than the Desktop `codex.exe`. If the Codex CLI is not on PATH, set `CODEX_BRIDGE_CODEX_COMMAND` to a working `codex.cmd` or `codex.ps1`, then restart the host.

### OpenCode cannot see the MCP server

Check that the OpenCode server type is `local`, the command array points to `scripts/mcp_server.mjs`, and OpenCode has been restarted. For managed execution, also check `opencode serve`, the port, and `OPENCODE_SERVER_URL`.

### New tools do not appear after an update

Restart Codex/OpenCode and create a new host conversation. Older conversations may cache old MCP tools and skills.

## Development and verification

Contributors can run from the repository root:

```powershell
npm test
npm run check
git diff --check
```

Current release: `0.8.0`. This release positions the repository as the Codex Bridge Toolkit Series, adds the parallel OpenCode host adapter, modular toolkit boundaries, and multi-session fail-closed orchestration.

More design notes:

- [Toolkit series design](docs/toolkit-series.md)
- [OpenCode configuration template](examples/opencode/README.md)
- [Codex native integration boundary](docs/codex-native-integration.md)
- [Demo recording script](docs/demo-script.md)
