#!/usr/bin/env node
// `npx excalidraw-ai` entry. The only difference from `node server.mjs` is
// that this one opens a browser, so the dev workflow keeps its behaviour.
process.env.AI_OPEN = process.env.AI_OPEN || "1";
await import("./server.mjs");
