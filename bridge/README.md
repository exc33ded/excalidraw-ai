# excalidraw-ai

An AI agent inside Excalidraw. A chat sidebar reads and edits the live canvas
through tools, generates whole diagrams from text via mermaid, cleans up
hand-drawn sketches with a vision model, and can act as an assistant, a
planning guide, or a step-by-step tutor. Every conversation is a chat with a
canvas of its own.

Built on the `@excalidraw/excalidraw` npm package rather than a fork of
Excalidraw. Bring your own API key: any OpenAI-compatible
`/chat/completions` endpoint works (OpenAI, DeepSeek, a local server). The
idea comes from PenEcho, an AI agent system for Excalidraw; this is an
independent implementation.

## Run it (one command)

    npx excalidraw-ai

One process on one port: the server serves the built app and its own `/api`.
It opens a browser at http://127.0.0.1:8787; click the gear in the AI panel to
add your API key. `--no-open` skips the browser, `PORT=1234` moves the port.
You do not need a key to start it.

## Run it from source

    cd bridge
    node server.mjs

    cd bridge/host
    npm install
    npm run dev              # http://localhost:5173, proxies /api to the server

Use :5173 while developing; the server only serves the built app if you have
run `npm run build` in `bridge/host`.

## What is inside

    cli.mjs                 `npx excalidraw-ai` entry (server + open a browser)
    server.mjs              HTTP server: /api/ai/* proxy, /api/chats store, static host
    client.mjs              wireExcalidrawAI(): one-shot paths + the agent loop + all tools
    agent-contract.mjs      persona, modes, the eight tool schemas, model-list parsing
    geometry.mjs            pure canvas helpers (bbox, labels, arrows, TOON rows)
    vision.mjs              OpenAI-compatible vision/chat calls
    diagram-contract.mjs    the diagram output contract + validateSkeleton()
    store.mjs               the chat store: one directory per chat, on disk
    static.mjs              serves the built host from one port
    host/                   Vite + React app: Excalidraw + the AI sidebar
    test.mjs                offline tests (no key, no browser)
    browser-test.mjs        Chrome tests (real key, both servers running)

## Configure (bring your own key)

Easiest: the settings screen. Pick a provider (OpenAI, DeepSeek, or "Other
(OpenAI-compatible)" for any endpoint), paste a key, **Test connection** -
it checks the key and lists the models that endpoint actually serves - then
**Save**. The key is stored in `config.json` (gitignored, written 0600) and
never sent back to the browser.

To set the key from a file instead:

    cp .env.example .env      # put your real key in .env (gitignored)
    node server.mjs

A key saved from the panel wins over `.env`, because it is the one you typed
most recently. Delete `config.json` to fall back to `.env`. Or pass env vars
directly (any OpenAI-compatible endpoint):

    AI_API_URL=https://api.deepseek.com/v1 AI_API_KEY=sk-... AI_API_MODEL=deepseek-chat node server.mjs

`AI_MODELS` pins the list the pickers offer (`id[:vision][:reasoning]
[:maxTokens]`, comma separated); the server refuses any model not on it.
Entries flagged `:vision` appear in the vision picker (Refine and the capture
tool) as well as the chat picker; `:reasoning` models need a large
`maxTokens` because they bill reasoning tokens against it before emitting
anything. A discovered model no preset knows is guessed from its id with a
conservative 8000-token budget (32000 is a 400 on most non-reasoning models).

The server binds 127.0.0.1 by default. To expose it, set
`AI_BRIDGE_HOST=0.0.0.0`, `AI_BRIDGE_TOKEN=<secret>` (the host sends it from
`VITE_AI_BRIDGE_TOKEN`), and `ALLOWED_ORIGIN`.

## Where your data lives

Chats live in `~/.excalidraw-ai/chats/`, one directory per chat:

    <id>/meta.json    title and timestamps
    <id>/chat.json    the visible log plus the model's own transcript
    <id>/scene.json   the canvas elements
    <id>/files.json   embedded images, written only when the image set changes

It is plain JSON with no database or service behind it: back a chat up by
copying its directory, delete one by deleting its folder. `AI_DATA_DIR` moves
the whole store. The routes behind it are `GET|POST /api/chats` and
`GET|PUT|DELETE /api/chats/:id`; like the config writes, they refuse
cross-origin requests.

## Test

    node test.mjs                        # offline, instant
    CHROME=/path/to/chrome node browser-test.mjs   # needs both servers + a key

## Wire your own app

    import { wireExcalidrawAI } from "./client.mjs";
    const ai = wireExcalidrawAI({ excalidrawAPI });
    await ai.refine();                   // selected sketch -> clean diagram draft
    await ai.generateFromText("...");    // text -> diagram draft
    await ai.agent.send("add two nodes");  // chat agent with canvas tools
    ai.accept();                         // one click: commit the draft (one undo step)
    ai.reject();                         // drop the draft

All API endpoints are overridable at wiring time; the key never has to leave
your server. The agent exposes `send` / `reset` / `revert` / `load`,
settings helpers (`models` / `status` / `test` / `setup`), and a chat store
client (`list` / `create` / `read` / `save` / `remove`). See the docs for the
full contract.

## The diagram contract

The vision model sees a rendered image whose pixel size depends on export
scale, so the skeleton it returns uses RELATIVE fractions of the image (0..1);
the client maps them onto a target rect. This is the "preserve layout" mode:
relative order, clusters and direction survive, and the geometry is repaired
client-side - arrows are snapped to bindings and run edge-to-edge.

Whole diagrams from the chat agent go through mermaid instead:
`@excalidraw/mermaid-to-excalidraw` lays them out (dagre), so boxes never
overlap and no connection is forgotten. Mermaid syntax errors are returned to
the model verbatim so it can fix them.

## Docs and source

- Architecture, protocol, tools, and roadmap: `docs/` in the repository
  (start at `docs/README.md`).
- Source: https://github.com/exc33ded/excalidraw-ai
- Inspired by [PenEcho](https://github.com/penecho/penecho), an AI agent
  system for Excalidraw.
- MIT.
