# 01 - Architecture overview

Penecho's AI is not one thing; it is two independent layers that share a common
idea: the AI sees the canvas (image or structured state) and acts on it.

## The two paths

| | Legacy one-shot vision | PenEcho Agent (main) |
| --- | --- | --- |
| Entry | POST /api/ai/command | WebSocket /api/canvas-agent/socket |
| Input | Rendered image crop ("atlas") + text | Chat message + synchronized canvas state + selection |
| Brain | One vision-model call | External CLI agent (Kimi/Codex/Claude) on DeepSeek Harness |
| Output | One JSON array of commands | Multi-turn: tool calls against the live canvas |
| State | Stateless | Session + revision + stateDigest |
| Where | src/server/main.js | src/server/canvas-agent/* |
| Status for us | Ported (bridge/) | To be built |

## Agent data flow (layer 2)

    browser chat panel (src/client/app/canvas-agent-runtime.js)
        |  sends turn + references (selection, viewport, attachments)
        v
    WebSocket server (src/server/canvas-agent/http.js)
        |  envelope {version,type,canvasSessionId,clientId,seq,payload}
        v
    host-router.mjs  ->  CanvasHarnessHost (Harness) | CodexNativeHost (native)
        |
        v
    runtime.mjs  (PERSONA + session + all tools)
        |  canvas_* tools call session.rpc('canvas_*') back to the browser
        |  (single-writer, optimistic revision; browser canvas is authoritative)
        v
    cli-adapter.mjs  ->  external CLI (providers/kimi-cli.js, codex-cli.js, claude-cli.js)
        |  the CLI returns ONE JSON decision per turn: final text or one tool_call
        v
    Harness owns the loop: execute the tool, feed the result back, repeat.

## Key files

| File | Role |
| --- | --- |
| src/server/main.js | Legacy vision loop (SYSTEM_PROMPT, /api/ai/command) |
| src/server/canvas-agent/http.js | WebSocket bridge + host routing |
| src/server/canvas-agent/host-router.mjs | Routes between Harness host and native Codex host |
| src/server/canvas-agent/runtime.mjs | PERSONA, session, revision, all tools |
| src/server/canvas-agent/cli-adapter.mjs | Adapts an external CLI into the Harness model backend |
| src/server/canvas-agent/protocol.mjs | Client envelope parsing + protocol types |
| src/providers/{kimi,codex,claude}-cli.js | Spawn the external CLI agents |
| src/client/app/canvas-agent-runtime.js | The chat panel UI + canvas state sync |
| src/server/cloud-connector.js | Remote (cloud) canvas.agent.* operations |

## The invariant that matters

"Browser Canvas is authoritative." The agent never holds its own copy of the
canvas. It reads the latest synchronized state (canvas_inspect / canvas_read /
canvas_capture) and writes through atomic operations guarded by a revision
(baseRevision). After any conflict the agent must re-inspect.
