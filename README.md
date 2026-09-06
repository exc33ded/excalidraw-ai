# excalidraw-ai

[github.com/exc33ded/excalidraw-ai](https://github.com/exc33ded/excalidraw-ai) · MIT

An AI agent inside Excalidraw. A chat sidebar that reads and edits the live
canvas through tools, generates whole diagrams from text via mermaid, cleans up
hand-drawn sketches with a vision model, and can act as an assistant, a
planning guide, or a step-by-step tutor. Every conversation is a chat with a
canvas of its own; the chat list is the hamburger in the sidebar header.

Built on the `@excalidraw/excalidraw` npm package rather than a fork of
Excalidraw. The product is `bridge/`; nothing else is required to run it.

The idea comes from [PenEcho](https://github.com/penecho/penecho), an AI
agent system for Excalidraw, which is where the agent-owns-the-canvas model
and the sketch-to-diagram vision loop come from. This is an independent
implementation with its own tool loop, storage, providers, and UI.

    bridge/          the app: Node API server + Vite/React host + agent client
    docs/            architecture, protocol, and roadmap docs - start at
                     docs/README.md (01 architecture, 09 status & roadmap)

## Prerequisites

- Node 20.12 or newer (uses `process.loadEnvFile` and `AbortSignal.any`).
- An API key for any OpenAI-compatible chat endpoint (OpenAI, DeepSeek, a
  local server). `bridge/.env.example` has a preset for each.
- Chrome, only for the browser tests.

## Run

    npx excalidraw-ai

It runs as one process on one port and opens a browser at
http://127.0.0.1:8787. You do not need a key to start it: click the gear in
the AI panel, pick a provider and paste one.

Your chats live in `~/.excalidraw-ai/chats/`, one directory per chat, as plain
JSON with no database or service behind it. Set `AI_DATA_DIR` to keep them
elsewhere.

## Run from source

    cd bridge
    node server.mjs              # http://127.0.0.1:8787

    cd bridge/host
    npm install
    npm run dev                  # http://localhost:5173, proxies /api to 8787

Use :5173 while developing; the bridge only serves the built app if you have
run `npm run build` in `bridge/host`. Either way, click the gear in the AI
panel, pick a provider and paste your API key:
Test connection checks it and lists the models that provider serves. To pin the
list by hand instead, set `AI_MODELS` in `bridge/.env`
(`id[:vision][:reasoning][:maxTokens]`, comma separated). See `bridge/README.md`.

## Test

    cd bridge
    node test.mjs                # offline, no key
    node browser-test.mjs        # headless Chrome, needs both servers and a key
