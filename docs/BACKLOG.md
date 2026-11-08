# Backlog

Deferred tasks. Details are as of the day they were shelved — re-verify against
the code before picking one up.

## Give the agent hands: drive the UI (computer use)

Shelved 2026-11-07 (planned, not started). Goal: the in-app Agent can see the
Morpheus UI and click/type in it like a person, instead of only calling tools.

Decisions made while planning:

- A **headless Chromium driven through Playwright** (new `server/browser.ts`),
  enabled by `OPENFIELD_BROWSER=1`, pointed at the app with `OPENFIELD_UI_URL`.
- Agent-local tools (not in the MCP registry): `ui_screenshot`, `ui_click`,
  `ui_type`, `ui_scroll`, `ui_navigate`.
- **Eyes lift** as the transport: tool results that are images (screenshots,
  posters) go back to the model as image parts of the user message, instead of
  being flattened to `"[image]"` by `resultToText` (`server/agent.ts`).
- **A VLM is required**: the model the user runs (`google/gemma-4-4bit` in LM
  Studio) is text-only. Candidates discussed: Qwen2.5-VL 7B, Gemma 3 12B,
  UI-TARS-7B. A vision probe + cache would live in `server/llm.ts`.
- A **watch panel** in the Agent chat (live view of what the agent does in the
  UI) reusing the `/live` broadcast.
- **Budget of ~20 UI actions per turn** so the model cannot loop forever.

Pieces already in the code that this reuses:

- `server/llm.ts:23-33` — `LLMContentPart` already supports `image_url` parts.
- `server/index.ts:1995-2033` — the critique endpoint already sends base64
  frames to the LLM with a text-only fallback; the working eyes-lift pattern.
- `server/index.ts:1902` `posterFile()`, `:1928` `sampleFrames()`,
  `:2425` `/api/poster/:id`; `mcp/client.ts:231` `posterImage()`.
- `src/pages/Agent.tsx` — tool thumbnails, `show`/`flow` blocks.

Known risks from the plan: double-action loops (model both clicks UI and calls
tools), VLM coordinate drift on clicks, GPU contention between the render
queue and the browser, and the security surface of a browser that can post to
the API (keep it loopback-only, like the pairing listener).

## Phone pairing (done 2026-11-07)

"Open on your phone": a token-gated LAN reverse proxy of the whole app
(`server/phoneApp.ts`) behind a QR code in Setup. The one-shot clip drop box
(`server/phone.ts`) stayed as-is; the two share LAN detection in
`server/lan.ts`.
