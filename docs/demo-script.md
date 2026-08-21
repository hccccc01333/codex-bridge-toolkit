# Demo recording script

This script is for a privacy-safe README demo. Use a dedicated browser profile, a synthetic workspace, and fake task data. Do not record account details, email addresses, local usernames, private paths, API keys, cookies, or unrelated browser tabs.

## Demo 1: Brain-Hand loop

Target: 15–25 seconds, split-screen browser and Codex view.

### Preparation

Create a disposable demo workspace containing only a small project, for example:

```text
demo-project/
├── server.js
└── test.js
```

Use a visible ChatGPT Web or DeepSeek Web tab on the left and the Codex task on the right. Keep the browser sidebar and account identity out of frame.

### Shot list

| Time | Screen | Story |
| --- | --- | --- |
| 0–2s | Split screen | Show the labels `Web brain` and `Codex hands`. |
| 2–5s | Codex | Start: `Add a /health endpoint and one test. Do not change unrelated files.` |
| 5–8s | Web brain | Show `brain_plan` returning one concrete next task. |
| 8–14s | Codex | Show file inspection, edit, test execution, and a passing result. |
| 14–18s | Both | Show `executor_report` with changes, tests, and evidence. |
| 18–22s | Web brain | Show `brain_review` returning `completed` or `continue`. |
| 22–25s | Overlay | Show: `ChatGPT plans. Codex executes. Evidence closes the loop.` |

Keep the task small enough that the complete loop finishes during the recording. Do not show hidden reasoning; show only the visible plan, bounded report, and test evidence.

## Demo 2: Multi-tab routing

Target: 15–20 seconds.

Open three visible provider conversations in separate tabs and prepare three harmless task labels:

```text
route_frontend  → Frontend task
route_backend   → Backend task
route_tests     → Test task
```

Show the route/session selection changing between tabs, then show each route returning to its own conversation. The key overlay is:

```text
Independent tasks.
Independent tabs.
Persistent routing.
```

Do not show real conversation titles or personal browser tabs.

## Export recommendations

- Capture around 1440×800 or the nearest readable split-screen size.
- Keep each clip under 25 seconds.
- Use 12–20 fps for a GIF; prefer MP4/WebM for the full-resolution README demo.
- Crop out account identity, system tray, desktop paths, and unrelated tabs.
- Add the final files under `docs/assets/` only after the recording has been reviewed for secrets.

Suggested assets:

```text
docs/assets/hero-brain-hand.gif
docs/assets/multi-tab-demo.gif
```

After the assets exist, add them near the corresponding README sections. Until then, the README uses Mermaid diagrams so it has no broken media links.

## Scripted capture on Windows

FFmpeg is enough; OBS is not required. Arrange the browser and Codex windows side by side, then preview the capture rectangle:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\record_demo.ps1 `
  -BrowserTitlePattern "Microsoft Edge" `
  -CodexTitlePattern "^ChatGPT$" `
  -Preview
```

If more than one browser window matches, use a narrower title pattern. After the preview shows only the intended windows, record MP4 and optionally GIF:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\record_demo.ps1 `
  -BrowserTitlePattern "Demo project.*Microsoft Edge" `
  -CodexTitlePattern "^ChatGPT$" `
  -DurationSeconds 25 `
  -Output docs/assets/hero-brain-hand.mp4 `
  -GifOutput docs/assets/hero-brain-hand.gif
```

The script refuses to overwrite an existing output file and captures only the rectangle containing the selected browser and Codex windows. Review the MP4 before sharing it.
