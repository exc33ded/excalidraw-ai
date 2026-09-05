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
    client.mjs             wireExcalidrawAI() -> refine / accept / reject + the agent loop
    host/                  Vite + React app: Excalidraw + chat panel
    test.mjs               offline tests (no key, no browser)
    browser-test.mjs       Chrome tests (real key, both servers running)

## Run the server

    cd bridge
    cp .env.example .env      # put your real key in .env (gitignored)
    node server.mjs

Or pass env vars directly (any OpenAI-compatible endpoint):

    AI_API_URL=https://api.deepseek.com/v1 AI_API_KEY=sk-... AI_API_MODEL=deepseek-chat node server.mjs

Anthropic keys need a small extra adapter; say which provider when you share the key and I will add it.

## Run the host

    cd bridge/host
    npm install
    npm run dev               # http://localhost:5173

The Vite dev server proxies /api to the bridge server on :8787.

## Configure

See `.env.example`. `AI_MODELS` lists the models the panel's settings offer
(`id[:vision][:maxTokens]`, comma-separated); the server refuses any other
model. Entries flagged `:vision` appear in the vision picker (Refine and the
capture tool) as well as the chat picker. To add a model, append it to that
line and restart the server; no code changes.
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
