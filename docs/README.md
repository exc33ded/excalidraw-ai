# Penecho reverse-engineering notes

In-depth, module-by-module reference for Penecho's AI architecture, written to
support building the same AI on top of Excalidraw. All paths are repo-relative
to the penecho clone (v1.2.0) at excalidraw-ai/penecho.

## Index

| Doc | Covers |
| --- | --- |
| 01-architecture-overview.md | The two AI paths and the agent data flow |
| 02-chat-panel-ui.md | The right-side chat panel (client) |
| 03-agent-protocol.md | WebSocket bridge, envelopes, host routing |
| 04-agent-runtime-tools.md | Persona, session state, full tool inventory |
| 05-agent-brain-cli.md | External CLI brain (Kimi/Codex/Claude) |
| 06-selection-and-context.md | How selection is synced to the agent |
| 07-legacy-vision-loop.md | One-shot vision -> JSON commands (already ported) |
| 08-excalidraw-mapping.md | Penecho -> Excalidraw plan |
| 09-handoff.md | Current build state, what is proven, and the production objectives |

## Ten-second summary

Penecho has TWO AI layers:

1. Legacy one-shot vision: render a canvas crop -> vision model -> JSON
   commands (draw, write_text, plot_function, html_widget, ...). Already ported
   to bridge/diagram-contract.mjs + server.mjs.

2. PenEcho Agent (the main structure): a chat panel + an agent that owns the
   canvas through tools (canvas_inspect / read / create / edit / capture /
   set_view / patch_widget / revert), with the user's selection synced in as
   context, and an external CLI agent (Kimi / Codex / Claude) as the brain
   running on DeepSeek Harness.

The goal is to rebuild layer 2 on Excalidraw. See 08-excalidraw-mapping.md.
