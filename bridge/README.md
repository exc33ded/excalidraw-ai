# Excalidraw <-> Penecho AI bridge

Connects an Excalidraw canvas to Penecho's "understand the canvas by viewing it" AI, but emits Excalidraw elements instead of Penecho's raster draw commands.

## What maps where

| Penecho | This bridge |
| --- | --- |
| src/server/main.js SYSTEM_PROMPT (vision -> JSON commands) | bridge/diagram-contract.mjs (vision -> Excalidraw element skeleton) |
| /api/ai/command (image in, commands out) | /api/ai/diagram (image in, elements out) |
| callModelWithTrace + executors | bridge/vision.mjs (OpenAI-compatible call) |
| public/app.js command rendering (raster tiles) | bridge/client.mjs (convertToExcalidrawElements -> updateScene) |

## Files

    diagram-contract.mjs   the prompt + validateSkeleton() (the output contract)
    vision.mjs             buildVisionRequest() + callVisionModel()
    agent-contract.mjs     agent persona, tool schemas, model allowlist, history trimming
    geometry.mjs           pure canvas helpers (bbox, labels, TOON rows)
    server.mjs             /api/ai/diagram, /chat, /describe, /models (key stays server-side)
    store.mjs              the chat store: one directory per chat, on disk
    client.mjs             wireExcalidrawAI() -> refine / accept / reject + the agent loop
    host/                  Vite + React app: Excalidraw + chat panel
    test.mjs               offline tests (no key, no browser)
    browser-test.mjs       Chrome tests (real key, both servers running)

## Run it (one command)

    npx excalidraw-ai

One process on one port: the bridge serves the built app and its own `/api`.
It opens a browser at http://127.0.0.1:8787; click the gear in the AI panel to
add your API key. `--no-open` skips the browser, `PORT=1234` moves the port.

## Run it from source

    cd bridge
    node server.mjs

You do not need a key to start it. Open the host, click the gear in the AI
panel, pick a provider and paste your key: **Test connection** checks the key
and lists the models that provider actually serves, and **Save** stores it in
`bridge/config.json` (gitignored, 0600). Choosing "Other (OpenAI-compatible)"
lets you point at any endpoint that serves `/chat/completions`.

To set the key from a file instead:

    cp .env.example .env      # put your real key in .env (gitignored)
    node server.mjs

A key saved from the panel wins over `.env` — it is the one you typed most
recently. Delete `bridge/config.json` to fall back to `.env`.

Or pass env vars directly (any OpenAI-compatible endpoint):

    AI_API_URL=https://api.deepseek.com/v1 AI_API_KEY=sk-... AI_API_MODEL=deepseek-chat node server.mjs

Anthropic keys need a small extra adapter; say which provider when you share the key and I will add it.

## Where your data lives

Chats are kept in `~/.excalidraw-ai/chats/`, one directory per chat:

    <id>/meta.json    title and timestamps
    <id>/chat.json    the visible log plus the model's own transcript
    <id>/scene.json   the canvas elements
    <id>/files.json   embedded images, written only when the image set changes

Plain JSON, no database and no service - back it up by copying the directory,
and delete a chat by deleting its folder. `AI_DATA_DIR` moves the whole store.
The routes behind it are `GET|POST /api/chats` and
`GET|PUT|DELETE /api/chats/:id`; like the config writes, they refuse
cross-origin requests.

## Run the host

    cd bridge/host
    npm install
    npm run dev               # http://localhost:5173

The Vite dev server proxies /api to the bridge server on :8787.

## Configure

Easiest: use the panel's settings screen, which reads the model list from the
provider itself and needs no restart.

To pin the list by hand instead, see `.env.example`. `AI_MODELS` lists the
models the panel offers (`id[:vision][:reasoning][:maxTokens]`, comma-separated);
the server refuses any other model. Entries flagged `:vision` appear in the
vision picker (Refine and the capture tool) as well as the chat picker;
`:reasoning` marks models that spend their output budget on reasoning tokens
before emitting anything, which is why they need a large `maxTokens`. To add a
model, append it to that line and restart the server; no code changes.

A discovered model that no preset knows is guessed from its id and given a
conservative 8000-token budget, because 32000 is a 400 on most non-reasoning
models. Override it with `AI_MODELS` if the guess is wrong.
The bridge binds 127.0.0.1 by default. To expose it, set `AI_BRIDGE_HOST=0.0.0.0`,
`AI_BRIDGE_TOKEN=<secret>` (the host sends it from `VITE_AI_BRIDGE_TOKEN`), and
`ALLOWED_ORIGIN`.

## Test

    node test.mjs                       # offline, instant
    CHROME=/path/to/chrome node browser-test.mjs   # needs both servers + a key

## Wire your own app

    import { wireExcalidrawAI } from "./bridge/client.mjs";
    const ai = wireExcalidrawAI({ excalidrawAPI, endpoint: "/api/ai/diagram" });
    await ai.refine();  // rough sketch -> clean copy beside it
    ai.accept();        // one click: delete sketch, move clean into place (one undo step)
    ai.reject();        // delete the draft

## Contract

The vision model sees a rendered image whose pixel size depends on export scale, so coordinates are RELATIVE fractions of the image (0..1). The client maps them onto a target rect. This is the "preserve layout" mode: relative order, clusters and direction survive; a deterministic solver (dagre/elk) is a later opt-in.

Arrows MAY bind to nodes: give each node an id and set the arrow start/end to those ids. The client passes them to convertToExcalidrawElements with regenerateIds:false so startBinding/endBinding resolve. Unbound arrows (points only) still work as a fallback.
