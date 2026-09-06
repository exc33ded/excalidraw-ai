# excalidraw-ai documentation

excalidraw-ai is an AI agent inside Excalidraw: a chat sidebar that reads and
edits the live canvas through tools, generates whole diagrams from text, and
cleans up hand-drawn sketches with a vision model. The idea comes from
PenEcho, an AI agent system for Excalidraw; this is an independent
implementation built on the `@excalidraw/excalidraw` npm package. These docs
describe the project as it is. The product lives in `bridge/`, paths are
relative to it, and every claim here is grounded in that code.

## Index

| Doc | Covers |
| --- | --- |
| 01-architecture-overview.md | The two AI paths, the processes and data flow, the "browser canvas is authoritative" invariant |
| 02-chat-panel-ui.md | The AI sidebar: chat / history / settings views, modes, per-chat canvases, key setup |
| 03-protocol-and-api.md | HTTP routes, auth and CORS rules, the chat wire format, the `wireExcalidrawAI()` client contract |
| 04-agent-runtime-tools.md | The persona, the modes, the eight tools and their semantics, the tool loop |
| 05-providers-and-model.md | Providers, the model allowlist, discovery, where the key lives |
| 06-selection-and-context.md | How selection, bbox and viewport reach the model; tool fallbacks; the sketch working set |
| 07-vision-and-diagrams.md | Refine, text-to-diagram, the output contract, describe, draft accept/reject |
| 08-excalidraw-integration.md | The `@excalidraw/excalidraw` surface used, and the element-model traps it creates |
| 09-status-and-roadmap.md | What is built and verified, what is not, priorities, conventions, rough edges |

## Reading paths

- **New to the project**: 01, then 02 for what you see, 09 for what is done
  and next.
- **Embedding the AI in your own Excalidraw app**: 03 (client contract) and
  07 (the one-shot paths).
- **Working on the agent**: 04 (tools and loop), 06 (context), 08
  (integration traps).
- **Running it**: the root README (one command, run from source, tests) and
  `bridge/README.md` (configuration, storage, wiring your own app).

## Ten-second summary

One Node process serves a Vite/React host that wraps `@excalidraw/excalidraw`,
plus an HTTP API. The AI is two paths over one canvas:

1. **One-shot diagram paths** - Refine a selected sketch (or a text
   description) into a clean diagram in one vision-model call, shown as a
   draft you Accept or Reject.
2. **The chat agent** - a tool-calling loop (eight tools:
   `query_elements`, `create_elements`, `update_elements`,
   `delete_elements`, `connect_layers`, `create_diagram`, `set_view`,
   `capture`) that reads and edits the live canvas, with your selection and
   viewport appended to every message.

The model brain is any OpenAI-compatible `/chat/completions` endpoint; the
API key stays on the server. Every chat owns its own canvas, stored as plain
JSON under `~/.excalidraw-ai/chats/`. Mermaid is the agent's tool for whole
diagrams: a layout engine places the nodes, so boxes never overlap and no
connection is forgotten.
