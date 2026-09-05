# 09 - Handoff

Written 2026-09-05 at the end of the session that built the agent chat panel;
updated the same day by the session that made it usable day to day (model
picker, stop, persistence, revert, hardening, browser tests). Docs 01-08
describe Penecho and the porting plan; this one describes **what is actually
built right now**, what is proven, what is not, and what to do next.

Read this together with 08-excalidraw-mapping.md, which sets the phases.

---

## 1. The arrangement (decided, don't relitigate without cause)

**`bridge/host` is the product.** It is a Vite + React app wrapping the
`@excalidraw/excalidraw` npm package. `excalidraw/` and `penecho/` in this repo
are **read-only reference clones** — neither has `node_modules`, neither is
built, nothing imports from them. Use them to read implementation details only.

Why not fork `excalidraw-app`: every capability needed so far is on the
package's public API, and forking means owning a yarn monorepo build plus
permanent upstream merge cost. **Revisit only when per-turn undo forces it**
(see objective 5) — the imperative API exposes `history.clear` and nothing else.

> Trap: the `excalidraw/` clone is **newer** than the installed `^0.18.1`. Its
> source shows APIs that do not exist in the installed package. Always confirm
> against `bridge/host/node_modules/@excalidraw/excalidraw/dist/types/`.

---

## 2. What exists

    bridge/server.mjs           /api/ai/{diagram,chat,describe} + {status,test,config}
    bridge/vision.mjs           OpenAI-compatible vision + chat calls
    bridge/diagram-contract.mjs one-shot diagram prompts + validateSkeleton
    bridge/agent-contract.mjs   AGENT_SYSTEM_PROMPT + AGENT_TOOLS (no browser deps)
    bridge/geometry.mjs         pure helpers: bbox, selection expansion, labels, TOON rows
    bridge/client.mjs           wireExcalidrawAI(): tool implementations + the agent loop
    bridge/test.mjs             99 offline tests, no key and no browser needed
    bridge/browser-test.mjs     18 Chrome tests (puppeteer-core, real key, both servers up)
    bridge/host/src/AgentPanel  the chat panel, an Excalidraw <Sidebar> with a settings view
    bridge/host/src/App.jsx     Excalidraw + Footer (Refine / Accept / Reject) + scene save
    bridge/host/vite.config.js  aliases for client.mjs + the mermaid subgraph patch

**Run:** `node bridge/server.mjs` (127.0.0.1:8787) and `npm run dev` in
`bridge/host` (:5173, proxies `/api` to 8787). The key is **server-side either
way** and never reaches the browser; it can come from `bridge/.env` or from the
panel's settings screen, which writes `bridge/config.json` (see BYOK below —
`config.json` wins). `AI_MODELS` in `.env` is the picker's allowlist
(`id[:vision][:reasoning][:maxTokens]`) when no key was set from the panel.

**Server env, all optional:** `AI_BRIDGE_HOST` (default loopback), `AI_BRIDGE_TOKEN`
(bearer required on `/api/*`; the host sends `VITE_AI_BRIDGE_TOKEN`),
`ALLOWED_ORIGIN` (CORS, default `*`), `AI_TIMEOUT_MS` (upstream, default 180s).

### The agent

Seven tools: `query_elements`, `create_elements`, `update_elements`,
`delete_elements`, `create_diagram`, `set_view`, `capture`. The tool-calling
loop runs **in the browser** (`agentSend` in `client.mjs`); the server is only a
key-holding proxy. Max 20 steps per turn.

Per turn the panel passes `{ model, signal, onStep }`: the picked model (server
re-validates it against `AI_MODELS`), an `AbortController` signal behind the
Stop button (the server aborts the upstream fetch on request close), and a
callback that shows the running tool name. Each user message also carries the
selection ids + bbox and the viewport (scroll, zoom).

**State that survives a refresh** (all `localStorage`): panel width, model
choice, transcript (`excalidraw-ai-chat`), agent history
(`excalidraw-ai-agent-messages`, system prompt rebuilt from source on load,
screenshots replaced by a marker), and the scene itself (`excalidraw-ai-scene`,
debounced `onChange` → `initialData`). History is trimmed to ~120k chars by
dropping the oldest turns whole (`trimMessages`); Stop cuts back to the last
complete turn (`dropIncompleteTurn`) so no `tool_calls` is ever sent without
its results. Side effect: Stop pressed while the model is thinking *after* a
completed tool round drops that round from history too, so the canvas keeps
the edits but the model must re-query them next turn.

**Revert turn:** the scene is snapshotted before each turn; the header button
restores it in one `updateScene`. That is the whole per-turn undo.

Three decisions worth knowing before you change anything:

**Labels are not properties.** `convertToExcalidrawElements` turns a skeleton's
`label.text` into a *separate* text element with `containerId`
(`excalidraw/packages/element/src/transform.ts:235`). A live shape has **no
`.label`**. Every tool goes through `labelIndex()` / `toQueryRows()` in
`geometry.mjs`. Bound labels are hidden from `query_elements` — show them and the
model sees each label twice and tries to delete the "stray" one.

**Whole diagrams go through mermaid, not coordinates.** `create_diagram` takes a
mermaid definition and runs it through `@excalidraw/mermaid-to-excalidraw`
(already a dependency of the Excalidraw package; dagre inside). A model placing
x/y by hand produces arrows through boxes and forgotten edges — this was the
original bug. `create_elements` is for a few loose shapes and edits only.

**`query_elements` answers in TOON, not JSON.** The scene is a uniform array of
records, TOON's best case: measured 50% fewer characters on a 79-element scene
(8510 → 4273), and results accumulate in `agent.messages` all session. The live
model reads it correctly (verified). Rows must stay **uniform** — TOON only uses
its tabular form for uniform arrays, which is what the `toQueryRows` tests pin.

**The panel is an Excalidraw `<Sidebar>`** (`name="ai"`, opened by a
`Sidebar.Trigger` in `renderTopRightUI`, next to Library). So it *is*
Excalidraw UI: island, header, dock and close buttons, `--ui-font`, dark mode,
all inherited. There is no theme code, and adding some would be a regression.
Being inside Excalidraw's tree also means its *native* listeners are in the
bubble path — hence the native `wheel` stopPropagation in `AgentPanel.jsx`
(Excalidraw treats any `<textarea>` as canvas input, `App.tsx:13785`).

The header gear opens a settings view with **two pickers**: the chat model
(runs the agent loop) and the vision model (Refine and the `capture` tool).
Both come from `GET /api/ai/models`; the vision picker only lists entries
flagged `:vision`, and the server rejects a non-vision model on the vision
routes with a 400. Choices persist in `excalidraw-ai-settings`.

**BYOK: the key is set from the panel, not `.env`.** Editing `bridge/.env` by
hand rules out anyone who has never opened a terminal, which is the audience
for a downloadable build. `vision.mjs` already reads `config.apiKey` *per
call*, so making it settable at runtime needed no refactor — only `let MODELS`
and somewhere to persist the choice (`bridge/config.json`, gitignored, 0600,
and it wins over `.env` because it is what the user typed most recently).

    GET  /api/ai/status   { configured, provider, keyHint, providers[] }
    POST /api/ai/test     { provider | baseUrl, apiKey } -> what it serves
    POST /api/ai/config   { provider | baseUrl + models, apiKey } -> saves

The key is **never** returned by any route; `maskKey` reveals at most the last
four characters, and nothing at all below nine (`test.mjs` pins this).

**Test and discover are one call.** `GET {baseUrl}/models` with the key proves
the key works *and* reports the model list, and the status code is the whole
diagnostic: 401/403 = bad key, other non-2xx = wrong base URL, network error =
unreachable. It uses a 10 s timeout, deliberately **not** `AI_TIMEOUT_MS` —
180 s on a key test reads as a hang.

Two things that list cannot tell you, and how `mergeDiscoveredModels` fills
them in (all pure, all in `agent-contract.mjs`, all covered by `test.mjs`):

- **No vision or reasoning flag, no token budget.** Discovery supplies only
  candidate ids; `PROVIDER_PRESETS` supplies verified flags for ids it knows
  (a discovered `gpt-4o` keeps `vision:true, maxTokens:16000`), and unknown
  ids fall back to id heuristics. Non-chat ids (embeddings, whisper, TTS,
  image, realtime) are filtered out, or the chat picker fills with them.
- **An unknown id must not inherit the 32000 budget.** That figure suits
  reasoning models and is a 400 on most others, so unknown ids get 8000 unless
  the id looks like a reasoning model. A test pins that no discovered entry
  reaches 32000 without being flagged reasoning or known.

**A custom endpoint with no vision model says so.** `applyDiscovered` leaves
`config.model` empty rather than pushing a phantom id the provider would 404
on, and `/describe` and `/diagram` answer *"this endpoint has no vision model,
so Refine and capture are unavailable."* The preset path still guarantees a
vision entry, which is also what keeps `MODELS[0]` defined.

**The config and test routes are a write boundary the read routes are not.**
With the default `*` CORS, any page open in the user's browser could otherwise
POST a key to the loopback port — or, before the endpoint was user-supplied,
repoint `baseUrl` at a collector. `originOk()` refuses a cross-origin write
(verified: `Origin: https://evil.example` → 403). A missing `Origin` is
allowed, which is what lets curl and a future Electron main process work — so
it defends against web pages, **not** against another local process. Routes
now answer **503** (not 500) when no key is set, so the panel can tell "needs
setup" from "broke" and show its first-run banner.

**Modes.** Three tabs above the input: Assistant (edit the canvas, 1-2
sentence replies), Guide (planning: draw the plan, then a structured written
overview), Tutor (draw a roadmap, confirm it and ask prior knowledge, teach one
step per turn with a check question, re-explain when the answer shows a gap).
A mode is one behaviour paragraph appended to the shared canvas contract
(`AGENT_MODES` / `systemPromptFor` in `agent-contract.mjs`); the system message
is rebuilt from the picked mode on every send, so switching mid-conversation
takes effect immediately. Assistant replies get light markdown (bold, code,
headings, bullets) via `renderLite` in the panel. Verified live: a 4-turn
tutor conversation on HTTPS behaved as specified, including the
"not really" branch.

**Two converter fixes live outside `node_modules`:**
- `create_elements` computes an arrow's geometry from the two boxes it connects
  (`arrowBetween` in `geometry.mjs`). `convertToExcalidrawElements` binds an
  arrow but never positions it, so an arrow given only `start`/`end` ids came
  out with `x: null` and zero length.
- `create_elements` passes the scene elements a new arrow references into
  `convertToExcalidrawElements` and merges their updated copies back. The
  converter binds only within one call, so before this every arrow from a new
  box to an existing one silently lost its binding (seen live: dead-letter
  queue arrows drawn as loose lines). Loose arrows whose endpoints land inside
  boxes are also snapped to those boxes (`snapArrowEndpoints`), and
  `update_elements` with `text` on an unlabelled shape or arrow now creates the
  bound label instead of silently doing nothing.
- `bboxOf` skips elements with non-finite coordinates. One arrow with
  `x: null` (the bug above, on an older scene) made the scene bbox `null`, so
  every later `create_diagram` and text Refine landed at the origin on top of
  whatever was there. That was the "cluttered" pile-up seen on 2026-09-05.
- mermaid 11.17 prefixes subgraph `<g>` ids with the render id and
  `@excalidraw/mermaid-to-excalidraw` 2.2.2 still looks them up by exact id.
  Every flowchart with a `subgraph` (the persona's own example included)
  silently degraded to one flat **image** element. `vite.config.js` patches
  that one lookup in both the esbuild pre-bundle and the Rollup build; it
  throws at startup if the converter's source ever changes.

---

## 3. What is proven, and what is not

**Verified against the live model / test suites:**

- 94 offline tests pass (`node bridge/test.mjs`); host builds clean.
- BYOK, against mock OpenAI-compatible providers on loopback: discovery turned
  7 reported ids into 4 usable models (embeddings, whisper and dall-e filtered,
  a duplicate deduped, `o3-mini` flagged reasoning at 32000, unknown ids at
  8000); a 401 endpoint gave "the provider rejected this key (401)"; an
  unreachable one named the URL it tried; a cross-origin POST to `/test` and
  `/config` both 403'd; a text-only endpoint saved with `visionDefault: ""`
  and `/describe` then returned the no-vision-model message instead of a
  phantom id; the saved provider, key, baseUrl and model list survived a
  restart ("loaded saved settings: custom …1234, 2 models").
- The settings screen, clicked through in the user's own Chrome against the
  real DeepSeek endpoint: the form renders inside the sidebar in Excalidraw's
  own styling, Test connection returned "Key works · 3 usable models" with
  the vision and reasoning tags correct, and no console errors.

**A key from `.env` is not a preset.** The first browser pass caught the
settings screen reporting *OpenAI* while the app was running DeepSeek: a `.env`
key leaves `provider` empty, so the picker fell through to the first preset and
Update key would have swapped a working endpoint for that one. `/api/ai/status`
now reports `fromEnv` and the live `baseUrl`, and the picker gains an explicit
**From bridge/.env** entry that is testable but not saveable - switching away
has to be a deliberate choice of a provider. A test with neither provider nor
URL checks whatever is loaded, and an endpoint whose base URL matches a known
provider picks up that preset's verified flags.
- 18 browser tests pass (`node bridge/browser-test.mjs`, headless Chrome via
  `puppeteer-core`, `CHROME=` to point at the binary): panel renders inside
  `.excalidraw`; dark mode follows Excalidraw's toggle; `r`/Delete typed in the
  chat leave the tool alone; wheel over the chat does not zoom; picker lists
  the allowlist and persists; Stop yields "(stopped)" with a clean history;
  "rename the box labeled Start to Begin" changes the bound text; chat and
  canvas survive a refresh; revert restores the pre-turn element count;
  `create_diagram` produces bound arrows in a real browser.
- Allowlist rejects an unknown model with 400; a non-vision model on
  `/api/ai/describe` or `/api/ai/diagram` returns 400; bearer token gate
  returns 401.
- Live experiments (`deepseek-v4-flash` brain, `deepseek-v4-flash-vision-exp`
  eyes), all passing after the two converter fixes above: create two labelled
  boxes with an arrow (2 tool calls, 4 s); blue ellipse below a named box
  (1 call); move a box 200 px and its label follows (1 call); delete a shape
  and its label (1 call); transformer encoder/decoder via `create_diagram`
  (39 elements, 11 bound arrows, 8 s); insert a Dropout box into that diagram,
  wired in (12 calls, 75 s); capture-driven "does anything overlap" that found
  and fixed two real issues (11 calls, 107 s); Refine from a text description
  through the vision model, then Accept (79 s).
- Client hang-up reaches the upstream fetch: `curl -m 3` against :8787 and
  through the :5173 proxy both log "client left /api/ai/chat, aborting
  upstream". (Listener is on `res`, not `req` — `IncomingMessage` emits `close`
  once its body is consumed, so a `req` listener registered after `readJson`
  never fires.)
- `/api/ai/describe` round-trips a real screenshot to a description.
- Diagram generation: 5/5 successful runs on the prompt that used to fail ~1 in 3.
- The model reads TOON correctly (4/4 probes incl. label→container and arrow bindings).

**NOT verified:**

- The vision-brain capture path (a `:vision` model as the agent). `capture`
  then skips `/api/ai/describe` and appends a `user` message with the image
  after the tool results — the OpenAI format has no image slot in `tool`
  messages. Whether `deepseek-v4-flash-vision-exp` tolerates that mid-tool-loop
  has not been tried.
- The selection chip (only eyeballed in a screenshot). The resize grip is
  gone; Excalidraw's Sidebar has a fixed width.
- `AI_TIMEOUT_MS` firing against a genuinely hung provider.
- BYOK against a **real** provider. Everything above used mock `/v1/models`
  servers on loopback. Nobody has yet pasted a live OpenAI or DeepSeek key
  into the panel and run a turn on the discovered list.
- The reasoning and vision **heuristics**. They are regex guesses over model
  ids and will misfire on names nobody has seen. The honest upgrade is to read
  reasoning tokens back from the chat response's `usage` block after the first
  real turn and let the observed value overwrite the guess — `callChat`
  currently returns only `message`, so that needs plumbing. Until then a wrong
  guess costs a bad token budget, which surfaces as a 400 or a truncated reply.
- Saving a discovered list from a **real** provider. The test path was clicked
  through live (below), but nobody has pressed Save on it, so `config.json`
  has only ever been written by the mock-provider runs.
- Refine against an endpoint with **no vision model**, in the panel. The server
  side was verified (`/describe` returns the honest message, not a phantom id)
  and the path was traced by hand — `refine()` -> `post()` -> 400 -> `err.error`
  -> the `catch` in `App.jsx:45` -> the footer's `.ai-bar__error` — but it was
  not clicked, because the only configured endpoint here has a vision model and
  reconfiguring would have overwritten a working setup.

**The saved key is plaintext at rest, deliberately.** `config.json` is
gitignored and written `0600`, which is the same exposure as `bridge/.env` and
no worse. It is a `ponytail:` shortcut with the upgrade named in
`server.mjs`: if this ever ships as a desktop app, move it to the OS keychain
via Electron's `safeStorage` (DPAPI / Keychain), which needs no new dependency.
Do not treat the current state as an oversight — but do not ship an installer
without making that swap.

---

## 4. Objectives, in priority order

### 1. Multiple providers

**Adding a model today** is a Test connection in the settings screen, which
reads the list from the provider. To pin it by hand instead, one line in
`bridge/.env` and a server restart:

    AI_MODELS=deepseek-v4-flash:reasoning,deepseek-v4-pro:reasoning,some-new-model:vision:16000

Format is `id[:vision][:reasoning][:maxTokens]`. `:vision` puts it in the vision
picker and lets it serve `/describe` and `/diagram`; `:reasoning` is a label the
panel shows; the token budget defaults to 32000, which is right for reasoning
models and a 400 on most others, so set it. Any model on the same
OpenAI-compatible endpoint works as is. The chat picker shows every entry; the
vision picker only `:vision` ones.

**A custom endpoint no longer needs `.env` at all** — "Other
(OpenAI-compatible)" in the picker takes a base URL directly. What is still
missing is a *different message shape*: Anthropic needs an adapter
(`tool_use`/`tool_result` blocks), and `PROVIDER_PRESETS` is where a `provider`
field per entry would go.

What remains is **multiple providers**: everything assumes one
OpenAI-compatible `/chat/completions` at `AI_API_URL`. Anthropic needs an
adapter (different message shape, `tools` schema, and `tool_use`/`tool_result`
blocks). Keep the provider registry server-side so keys never reach the
browser. `parseModelList` is the natural place to grow a `provider` field per
entry, and `visionModelFor` / the chat allowlist check in `server.mjs` are the
two places that would route by it.

> Watch out: the DeepSeek models are **reasoning** models. `reasoning_tokens` are
> billed against `max_tokens` *before* any content is emitted, and vary hugely
> (measured 2,966 → 7,897 on the same prompt). `max_tokens` is set to 32,000 for
> this reason. Any new model needs its own budget, and `finish_reason: "length"`
> must stay distinguishable from malformed output.

### 2. Streaming text

Stop and per-step progress are done. Not done: SSE from `/api/ai/chat` to
render assistant text as it arrives. Deliberately skipped: the DeepSeek models
are reasoning models and emit their content at the very end, so streaming buys
little today. Revisit when a non-reasoning model is on the allowlist.

### 3. Storage beyond localStorage

Scene and chat persist per browser. `localStorage` is ~5 MB; a canvas with
embedded images will exceed it and the save silently skips (there is a
`ponytail:` comment in `App.jsx`). IndexedDB, or a server-side session, is the
upgrade. History trimming is by character count, not tokens; summarising old
turns instead of dropping them is the next refinement.

### 4. Hardening beyond localhost

Loopback bind, optional bearer token, CORS origin and upstream timeout are in.
Still absent, and needed before exposing the port to more than one trusted
user: a per-user budget (`capture` is a full vision call each time; Penecho
rate-limited its equivalent, `visualExplorerBudget`, doc 04), and real auth
instead of a shared secret. Per-IP limiting is pointless behind the Vite proxy
(every request arrives from 127.0.0.1), which is why none was added.

### 5. Per-turn undo, properly

The snapshot revert works and did **not** reopen the fork question. Its limits:
one level only (the previous turn), and it also discards any manual edits the
user made during the turn. Reaching Excalidraw's own history stack would fix
both and requires forking `excalidraw-app`. Leave it until someone asks.

### 6. Browser tests in CI

`browser-test.mjs` exists and passes, but it spends real tokens (four agent
turns) and needs a Chrome binary. It is a manual gate, not a CI job. To make it
free: stub `/api/ai/chat` with canned tool-call responses so the loop, tools
and panel run without a key.

### 7. Complex edits are slow

Editing inside a mermaid-made diagram works but costs 10-12 tool steps and a
minute or more: the model re-queries the canvas several times and captures
after each change. Two cheap wins: let `query_elements` take a bbox so the
model can ask for "the encoder region" once, and return the changed rows from
`update_elements`/`create_elements` so it does not re-query to confirm.

### 8. Context parity with Penecho

Selection ids, bbox and viewport go with every message. Still absent: the lasso
region, re-sync on every state change (doc 06), image attachments (Penecho's
`attachmentIds`), and multi-file / project context.

---

**Refine reads captions and positions its own arrows.** Text elements inside
the selection are sent to the vision model as words as well as pixels, with an
instruction to treat them as the subject of the drawing. Before that, a
scribble captioned "neural network" came back as a faithful copy of the
scribble. Arrows from any model output (chat `create_elements`, Refine, text
generation) go through `positionBoundArrows` so they run edge to edge; the
models' own arrow points usually end inside the node. Verified live: a messy
2-3-1 sketch captioned "neural network" came back as x1, x2, h1..h3, y with
9 of 9 arrows bound and ending at node edges, in 35 s.

**Refine needs a selection.** It used to fall back to the whole canvas when
nothing was selected, which redrew everything the moment a second diagram
existed. Now the footer button is disabled until something is selected (it
shows the count) and `refine()` throws without one; ctrl+A is the explicit
"everything". The selection still expands to bound arrows, their far ends,
groups and frames before rendering.

## 5. Conventions to keep

- Pure logic goes in `geometry.mjs` / `agent-contract.mjs` (no `@excalidraw`
  import) so `test.mjs` can cover it without a browser.
- `client.mjs` lives **outside** the host's root, so any bare import it uses
  needs an alias in `bridge/host/vite.config.js`. Three are there already
  (excalidraw, toon, mermaid-to-excalidraw). This bites every time.
- API keys stay server-side. The browser only ever talks to `/api/*`.
- `ponytail:` comments mark deliberate shortcuts and name their upgrade path —
  there is one on label re-wrap and one on the localStorage scene save.
- `browser-test.mjs` is the second test layer: anything that needs the DOM,
  the live API, or Excalidraw's event handling goes there, not in `test.mjs`.
- The panel is Excalidraw's own Sidebar, so it has whatever Excalidraw gives
  it: fixed width, dock toggle, close button, and Excalidraw's mobile
  behaviour. Do not reintroduce a custom panel to get a resize grip back.
- In dev builds `window.excalidrawAPI` and `window.ai` are exposed;
  `ai.tool(name, args)` runs a canvas tool with no model in the loop. That is
  how the converter bugs above were isolated.

## 6. Known rough edges

- Mermaid layouts are geometric and grid-like, not hand-placed. Correct and
  non-overlapping, which is the point, but visually distinct from a sketch.
- `create_diagram` places a **new block beside** existing content; it cannot
  merge into a diagram already on the canvas.
- Opening Library closes the AI sidebar and vice versa: Excalidraw renders one
  sidebar at a time.
- `set_view` / `capture` silently fall back to the whole canvas on unknown ids.
- Label re-wrap: editing a label to a much longer string keeps the old box width
  (`wrapText` is not exported from the package).
