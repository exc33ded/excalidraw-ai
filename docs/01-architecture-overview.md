# 01 - Architecture overview

excalidraw-ai is an AI agent that lives inside an Excalidraw canvas. It is
built on the `@excalidraw/excalidraw` npm package rather than a fork of
Excalidraw. The idea comes from PenEcho, an AI agent system for Excalidraw
(see the root README); the implementation here is independent and runs
against any OpenAI-compatible model endpoint.

The product is `bridge/`. Nothing else in the repo is required to run it.

## The two AI paths

excalidraw-ai is two surfaces that share one canvas and one key:

| | One-shot diagram paths | Chat agent |
| --- | --- | --- |
| Entry | Refine / generate-from-text buttons | Chat panel send |
| Input | Selected sketch rendered to an image, or a text description | Chat message + selection + viewport |
| Brain | One vision-model call (`/api/ai/diagram`) | Multi-turn tool loop (`/api/ai/chat`) |
| Output | A draft element set you accept or reject | Tool calls against the live canvas, then a reply |
| State | Stateless (a draft object only) | `agent.messages` transcript + per-turn snapshot |
| Where | `client.mjs` + `vision.mjs` | `client.mjs` + `agent-contract.mjs` |

Both paths can create whole diagrams from mermaid, but differently: the chat
agent's `create_diagram` tool parses mermaid in the browser with
`@excalidraw/mermaid-to-excalidraw`, while the one-shot text path asks the
vision model to invent elements from a description.

## Processes and data flow

    host/ (Vite + React, @excalidraw/excalidraw)
      |  Excalidraw <Sidebar> = AI panel; chat list, settings, send box
      v
    client.mjs (in the browser): the agent runtime
      |  tool implementations call excalidrawAPI.updateScene / exportToBlob
      v
    server.mjs (one Node process, one port 8787)
      |  proxy: /api/ai/*  - the API key lives here, never in the browser
      v
    any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, ...)

In development Vite serves the host on :5173 and proxies `/api` to the server;
in production (`npx excalidraw-ai`) the server serves the built host itself, so
it is one process and one port.

The agent loop runs in the browser, not on the server. `client.mjs` keeps the
conversation transcript, executes the tool calls the model asks for against
the live `excalidrawAPI`, and feeds the results back. The server only proxies
model calls and enforces the model allowlist, so the key stays server-side.

## Where the canvas state lives

"Browser canvas is authoritative." There is no server-side copy of the canvas
and no server-side agent state. The agent reads the live scene
(`query_elements`, `capture`), writes through `updateScene` with fresh unique
ids, and one snapshot taken before each turn supports a one-step "revert this
turn" undo. Chat history and canvases are persisted to disk per chat (see 02
and 09).

## Key files

| File | Role |
| --- | --- |
| `server.mjs` | HTTP server: `/api/ai/*` proxy, `/api/chats` store routes, static host, BYOK config |
| `client.mjs` | `wireExcalidrawAI()`: the one-shot paths, the agent loop, all tool implementations |
| `agent-contract.mjs` | System prompt, the eight tool schemas, modes, model-list parsing (no `@excalidraw` import) |
| `geometry.mjs` | Pure canvas helpers: bbox, relative->absolute mapping, labels, arrow geometry |
| `vision.mjs` | OpenAI-compatible vision/chat calls (one-shot diagram, describe, agent chat) |
| `diagram-contract.mjs` | The diagram output schema, prompts, and `validateSkeleton()` |
| `store.mjs` | Chat store on disk: one directory per chat under `~/.excalidraw-ai/chats/` |
| `static.mjs` | Serves the built host from one port (path-traversal-safe) |
| `host/src/App.jsx` | Host app: canvas + chat wiring, per-chat scene persistence |
| `host/src/AgentPanel.jsx` | The AI sidebar UI (Excalidraw `<Sidebar>`), settings screen, modes |

`agent-contract.mjs`, `geometry.mjs` and `diagram-contract.mjs` never import
`@excalidraw/*`, so the offline test suite (`test.mjs`) covers them without a
browser.

## Security posture

- The server binds 127.0.0.1 unless `AI_BRIDGE_HOST` says otherwise; the API
  key behind that port is the whole threat model.
- The API key never round-trips to the browser: `/api/ai/status` reports only
  a masked hint, and the settings screen sends a provider *name*, never a base
  URL, so a cross-origin attacker cannot repoint the bridge at their own
  collector.
- Config writes and the chat store refuse cross-origin requests (`originOk`);
  `/api/ai/*` refuses any model not on the allowlist; an optional bearer token
  gates everything.
- Upstream calls abort when the browser gives up (Stop, closed tab) and time
  out after `AI_TIMEOUT_MS`.

See 03 for the route reference, 04 for the agent tools, 07 for the vision
paths, and 09 for what is built, proven, and next.
