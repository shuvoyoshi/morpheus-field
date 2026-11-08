# The Agent

The Agent is a chat inside the UI that drives the whole studio. You describe
what you want in plain words, and a local model plans a multi-step job, shows
it to you as a checklist, and — once you approve — calls Morpheus's own tool
set to queue the renders on your GPU, chaining them until the ask is done: a
still, then the shot from it, then the upscale, and so on. It reports what it
made and where (the take id and file path).

It is the same idea as [MCP](MCP.md) from the other side. The tools live in one
place — [`mcp/tools.ts`](../mcp/tools.ts) — and two consumers share them: the
MCP stdio server, for external agents (Claude Code, Desktop), and the in-app
agent (`server/agent.ts`), for the chat in the UI. Both build the same request
bodies and hit the same routes, so a take the Agent queues is the same take you
would get from any other app, and it shows up live in the UI's history.

## Setup

The Agent needs the same OpenAI-compatible server the Scene planner uses — LM
Studio, llama.cpp, vLLM, or any server with a `/v1/chat/completions` and
`/v1/models`. Set it in two ways, and they combine:

- **In the app.** Open the **Agent** page (it is in the Apps gallery) or the
  **Agent model** tile in **Setup**. Enter the server URL (e.g.
  `http://127.0.0.1:1234/v1`), an optional API key, then **Load models** and
  pick one — each model shows its size, context and quantization when the server
  reports them (LM Studio does). **Save** stores it and the agent switches over
  immediately, no restart. The header chip then shows the active model and lets
  you swap it in place.
- **In `.env`.** `OPENFIELD_LLM_URL`, `OPENFIELD_LLM_MODEL`, `OPENFIELD_LLM_KEY`,
  `OPENFIELD_LLM_REASONING`. These are the defaults; a value saved in the app
  overrides the matching variable, per field. So `.env` is a fine way to set it
  once, and the app is a fine way to change it later.

The difference from the Scene planner is the model: the Agent needs **tool
calling**, because it drives the apps by calling them. A tool-capable model such
as Qwen3 (a thinking model works well — its reasoning streams into the collapsed
"thinking" panel) or gpt-oss fits; a plain chat model that cannot call tools
will not drive it.

## How a turn works

The agent runs a small loop (`server/agent.ts`) around the LLM
(`server/llm.ts`):

1. It asks the model for the next step, giving it the 33-tool set plus
   `present_plan` and `show_take`.
2. If the model calls a real tool, the agent dispatches it (the same handler the
   MCP server uses), reports the result back, and asks again.
3. If the model answers in text, that is the final reply and the turn ends.
4. If the model calls `present_plan`, the agent stops and waits for you.

Rounds are capped (12) and the LLM has an idle and total timeout, so a stuck
model ends the turn with what it has rather than hanging. Closing the chat
(Stop, or leaving the page) aborts the in-flight turn; renders already queued
are separate takes you can cancel on their own.

When a turn that queued takes ends, the page alerts you (a toast, and a browser
notification if the tab is in the background) and calls `POST /api/free`, the
same Free VRAM action as Setup, so the GPU is clean for the next prompt. The
models reload on demand when the next render starts.

### Plans, before the GPU is spent

For a job that clearly needs several GPU steps, the model proposes a plan first
instead of rendering. The page shows it as a numbered checklist with a **Run the
plan** button; **Discard** drops it. Approving sends the steps back to the model
with "execute now, do not present it again," and it works through the list.
Single-step asks skip the plan and go straight to the tool.

### Thinking, collapsed by default

The model's reasoning streams in live and shows as a "Thinking" line with a
pulse. The text of it stays collapsed until you expand it; the **Thinking**
switch in the header opens every thinking block at once. A model that hides its
reasoning in the reply (its thinking block, between the model's thinking tags)
is split out the same way, so the reply you read never carries the working.

## The wire

The chat streams over SSE from `POST /api/agent/chat`. The wiring lives on
`GET /api/agent/config` (the effective URL/model, with per-field provenance) and
`PUT /api/agent/config` (save it; `null` clears a field back to `.env`).
`GET /api/agent/models` lists the server's models, with stats when it is LM
Studio. Events arrive in order:

| event | meaning |
|---|---|
| `loading` | the model is silent — likely loading weights. Sent first; `ready: true` clears it on the first token |
| `thinking` | a reasoning delta (collapsed by default) |
| `text` | a delta of the reply you read |
| `tool_call` | the model asked to run a tool (name + args) |
| `tool_done` | the tool finished (ok / failed + a summary) |
| `take` | a take id queued by a tool, for the live card |
| `show` | the takes a `show_take` call lists (ids + `flow`), rendered side by side — or as the arrow chain when `flow` is on |
| `plan` | a multi-step plan, awaiting approval |
| `error` | something went wrong |
| `done` | the turn finished (steps used, elapsed) |
| `stopped` | you stopped it |

A live turn is stopped with the chat's **Stop** button: it aborts the agent
loop, and the running render is cancelled with `POST /api/stop`.

## What the page shows

- **History, immediately.** A new chat is created as the first turn starts, so
  the conversation appears in the left rail right away instead of minutes later.
  Rows have a checkbox; the **History** head has a select-all checkbox
  (indeterminate when partially selected) and a bulk **Delete** (trash) action.
- **Media in the chat.** Every take the turn queues shows as its own preview
  card, and at the end of the turn a **Created · N** strip recaps them. Ask it
  to show you takes that already exist — "show me the latest images" — and it
  calls `show_take`, which renders them side by side in a grid (a single take
  gets a wider card); takes it only shows do not enter the **Created** strip.
  Ask how a take was made and it calls `show_take` with `flow: true`; the page
  walks the take's parents and renders the chain oldest-to-newest with arrows,
  each card captioned `#id · app · model`. The thumbnail on a tool card opens
  the viewer, as does any card. A card whose take the live socket missed is
  resolved by fetching it, so it does not sit on "Queued…" forever.
- **Loading model.** If the model is silent for 1.5 s (cold weights), a
  "Loading model…" progress bar appears under your message and clears on the
  first token.
- **Approved plans as a to-do.** Once you run a plan it pins as a checklist with
  a box per step (pending / working / done / failed) and **Stop**, **Pause** and
  **Resume** controls; it unpins when the turn ends, keeping the final checks.
- **Library drawer.** The **Library** link in the rail opens a side panel of your
  finished takes (filter by type). Click an item to preview it full-screen; the
  clipboard icon adds it to the prompt as a `take:<id>` reference. **Open full
  library** goes to the full Library page.

## Test it without a model

`npm run test:agent` runs the loop against a fake OpenAI server — streamed
reasoning before the reply, inline thinking split out, a `present_plan` turn
that must not touch the engine, and a failing tool call that is reported before
the turn recovers. `npm run test:llm-config` checks the config store — the
saved-over-`.env` precedence, saving and clearing a field, and the model list
(ids from `/v1/models`, enriched with LM Studio's stats, and the plain-OpenAI
fallback). No LLM and no GPU needed for either.
