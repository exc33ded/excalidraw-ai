# 09 - Status & roadmap

State of the project as of 2026-09-05. This is the living document: what is
built and verified, what is not verified yet, and what is next, in priority
order.

## What is built

- **Product shape**: one command (`npx excalidraw-ai`) - one process, one
  port, serves the app and the API, opens a browser. Dev mode is Vite on
  :5173 proxying `/api` to the server.
- **Bring-your-own-key**: provider presets (OpenAI, DeepSeek), an
  "Other (OpenAI-compatible)" custom endpoint, Test connection -> model
  discovery -> Save to `config.json` (0600). A `.env` key gets its own
  "From bridge/.env" entry in the picker so saving can never silently swap a
  working endpoint for a preset. Keys stay server-side.
- **One-shot paths**: Refine (sketch -> clean diagram: selection plus 1-hop
  context, marked image, captions as words, relative-coordinate skeleton),
  text -> diagram, and the draft lifecycle (Accept/Reject, one undo step).
  `/api/ai/describe` turns screenshots into words.
- **The agent**: chat with eight canvas tools (04), per-turn mode prompts
  (assistant / guide / tutor), a stop that aborts upstream and keeps the
  transcript clean, TOON-compressed queries, whole-turn transcript trimming,
  and one-step revert of the last turn.
- **Every chat owns a canvas**: `store.mjs` keeps one directory per chat
  under `~/.excalidraw-ai/chats/` (meta, chat log + model transcript, scene,
  files) with atomic `.tmp`+rename writes and a 500ms scene debounce.
  Reopening a chat restores canvas, conversation, and model state together.
  First user message auto-titles the chat; legacy single-canvas data
  migrates into chat #1.
- **Security**: loopback bind by default, optional bearer token, model
  allowlist enforced server-side, cross-origin refusal on config and chat
  routes, upstream abort on client disconnect and a 180s timeout.

## What is verified

- **117 offline tests** (`node bridge/test.mjs`), no key, no browser; host
  builds clean.
- **18 browser tests** (`node bridge/browser-test.mjs`, headless Chrome via
  puppeteer-core): the panel renders inside Excalidraw's own chrome and
  follows dark mode; keystrokes and wheel events in the chat do not leak to
  the canvas; pickers persist; Stop leaves a clean history; "rename the box
  labeled Start to Begin" edits the bound text; chat and canvas survive a
  refresh; revert restores the pre-turn element count; `create_diagram`
  produces bound arrows in a real browser.
- **Model-path checks**: allowlist rejects unknown models with 400; non-vision
  models are refused on the vision routes; the bearer gate 401s; client
  hang-up reaches and aborts the upstream fetch; discovery filtered 7 reported
  ids to 4 usable models with correct vision/reasoning flags and budgets;
  saved settings survive a restart.
- **Live experiments** (DeepSeek chat + vision models): create two labelled
  boxes with a bound arrow (2 tool calls, ~4s); move a box and its label
  follows; delete a shape and its label; a 39-element transformer via
  `create_diagram` (11 bound arrows, ~8s); insert a node into that diagram
  (12 calls); capture-driven "does anything overlap?" found and fixed two real
  issues; Refine from text through the vision model then Accept (~79s);
  Refine turned a captioned 2-3-1 sketch into a clean 9-arrow bound diagram.
- **Packaging**: `npm pack` produces a clean tarball (no `.env`,
  `config.json`, tests or logs) that runs with no `node_modules` and no key,
  serves the app, and reports the unconfigured state honestly.

## What is not verified yet (honestly)

- **The vision-brain capture path**: `capture` with a `:vision` chat model
  appends the image as a user message after the tool results (the OpenAI
  format has no image slot in tool messages). Whether a real vision model
  tolerates that mid-tool-loop has not been tried.
- **BYOK against a real provider from the panel**: test suites used mock
  `/v1/models` servers on loopback; nobody has pasted a live key and run a
  turn on the discovered list. (Save, in particular, has only ever written
  `config.json` from the mocks.)
- **The reasoning/vision heuristics**: regex guesses over model ids will
  misfire on unseen names. The honest upgrade - read the actual
  `reasoning_tokens` back from `usage` after the first turn and let the
  observed value overwrite the guess - needs plumbing in `callChat`.
- **The npm package is deferred.** `excalidraw-ai` will be published later,
  once a few remaining items are settled (the name has not been checked for
  availability and nothing has been pushed yet). Until then, run from source:
  `cd bridge && node server.mjs`. `npx excalidraw-ai` is the target
  distribution, not yet a fact.
- **`AI_TIMEOUT_MS`** firing against a genuinely hung provider.
- The saved key is plaintext at rest, deliberately: gitignored,
  written 0600 - the same exposure as `bridge/.env`. If this ever ships as a
  desktop app, move it to the OS keychain (`safeStorage`), no new dependency.

## Roadmap, in priority order

1. **Multiple providers with different message shapes.** Everything assumes
   one OpenAI-compatible `/chat/completions` endpoint. Anthropic needs an
   adapter (`tool_use`/`tool_result` blocks). Keep the provider registry
   server-side; grow a `provider` field per entry in `parseModelList`.
2. **Streaming text.** SSE from `/api/ai/chat` so assistant text renders as it
   arrives. Deliberately skipped so far: the reasoning models emit content at
   the very end, so streaming buys little today. Revisit when a non-reasoning
   model is on the allowlist.
3. **Chat-store refinements** (history/per-chat canvases themselves are done):
   search across chats, export/import, and trimming/summarising old turns
   instead of dropping whole turns by character count.
4. **Hardening before multi-user exposure.** Loopback, token, CORS and timeout
   are in. Still absent: a per-user budget (`capture` is a full vision call
   each turn) and real auth instead of a shared secret.
5. **Deeper per-turn undo.** The snapshot revert is one level and discards any
   manual edits made during the turn. Reaching Excalidraw's own history stack
   would fix both but requires forking `excalidraw-app`; leave it until asked.
6. **Browser tests in CI.** They pass but spend real tokens and need Chrome.
   Stub `/api/ai/chat` with canned tool-call responses to make the suite free.
7. **Complex-edit speed.** Editing inside a mermaid-made diagram costs 10-12
   tool steps and a minute-plus. Two cheap wins: `query_elements` takes a bbox
   ("the encoder region"), and `update_elements`/`create_elements` return the
   changed rows so the model does not re-query to confirm.
8. **Context parity.** Selection ids, bbox and viewport already travel with
   every message. Still absent: a lasso/region shape, live canvas re-sync,
   user image attachments, and multi-file / project context.

## Known rough edges

- Mermaid layouts are geometric and grid-like, not hand-placed - correct and
  non-overlapping, which is the point, but visually distinct from a sketch.
- `create_diagram` places a new block **beside** existing content; it cannot
  merge into a diagram already on the canvas.
- Excalidraw renders one sidebar at a time: opening Library closes the AI
  panel and vice versa.
- `set_view` / `capture` silently fall back to the whole canvas on unknown ids.
- A label edited to a much longer string keeps its old box width (the package
  does not export `wrapText`).

## Conventions to keep

- Pure logic lives in `geometry.mjs` / `agent-contract.mjs` /
  `diagram-contract.mjs` (no `@excalidraw` import) so the offline suite can
  cover it without a browser.
- `client.mjs` lives outside the host's root, so its bare imports need aliases
  in `bridge/host/vite.config.js` (excalidraw, toon, mermaid-to-excalidraw).
- API keys stay server-side; the browser only ever talks to `/api/*`.
- `ponytail:` comments mark deliberate shortcuts and name their upgrade path.
- `browser-test.mjs` is the second test layer: DOM, live API, and Excalidraw
  event handling go there, not in `test.mjs`.
- The panel is Excalidraw's own Sidebar: fixed width, dock toggle, close
  button, mobile behaviour. Do not reintroduce a custom panel for a resize
  grip.
