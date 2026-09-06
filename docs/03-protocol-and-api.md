# 03 - Protocol & server API

One Node process (`server.mjs`) exposes everything: the model proxy, the chat
store, and the built host. There is no WebSocket and no envelope format; the
protocol is plain HTTP/JSON plus the tool-calling loop described below.

## Conventions

- Every response is JSON with `Cache-Control: no-store`, except static assets.
- Errors are `{ "error": "human-readable reason" }` with a meaningful status
  code (400 bad input, 401 missing token, 403 cross-origin config write,
  404/422 not found / invalid model output, 500 upstream or internal failure,
  503 no key configured yet).
- `OPTIONS` answers 204 with the CORS headers.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness probe; always `{ ok: true }`. |
| `GET /api/ai/models` | The allowlist. With no key configured: `{ models: [], default: "", visionDefault: "" }` (nothing to offer). Otherwise `{ models: [{ id, vision, reasoning, maxTokens }], default, visionDefault }`. |
| `GET /api/ai/status` | First-run detection for the settings screen: `{ configured, provider, fromEnv, baseUrl, keyHint, providers: [{ id, label, keysUrl }] }`. Never returns the key; `keyHint` is masked (last 4 chars, `…` otherwise). |
| `POST /api/ai/test` | Try a key + endpoint without saving. Body: a provider preset *name*, or `baseUrl` + `apiKey` (empty `apiKey` = test the key already loaded; empty everything = test the current config). Returns `{ ok, baseUrl, models, found }` after discovery; 422 when the key works but the endpoint serves no chat models. |
| `POST /api/ai/config` | Save BYOK settings. Body: a preset name + `apiKey`, or `baseUrl` + a discovered `models` list + `apiKey`. Writes `config.json` (0600). Returns the new `status` shape plus `models`/`default`. |
| `POST /api/ai/diagram` | One-shot diagram path. Body: `image` (base64 `data:image/*` URL) and/or `text`. Text + image: "clean up this sketch". Text only: generate a diagram from the description. Validates the model's element output against the skeleton contract (07); 200 `{ elements }`. |
| `POST /api/ai/chat` | Agent brain call. Body: `{ messages, tools?, model }`. `model` must be on the allowlist or the default is used; a named model off the list is a 400. 200 `{ message }` - one assistant message which may carry `tool_calls`. |
| `POST /api/ai/describe` | Words from an image, for the agent's `capture` tool when the brain has no vision. Body: `{ image, question? }`. 200 `{ description }`. |
| `GET/POST /api/chats` | List chats / create one (`{ title }` -> `{ meta }`). |
| `GET/PUT/DELETE /api/chats/:id` | Read a chat (meta + chat + scene + files), patch it, or delete it. PUT body is a partial patch: any of `{ chat, elements, files, title }`. |

Anything that is not `/api/*` and is a GET is the built host (`static.mjs`,
SPA fallback to `index.html`; 503 with instructions when no build exists).
Anything else is 404. A path traversal in the static layer is blocked by
`safeJoin`, which resolves the URL and proves the result stays inside the
build directory.

## Who may call what

- If `AI_BRIDGE_TOKEN` is set, every request needs `Authorization: Bearer
  <token>`; otherwise 401. The host sends it from `VITE_AI_BRIDGE_TOKEN`.
- `POST /api/ai/test`, `POST /api/ai/config`, and every `/api/chats` route
  (including the GETs) call `originOk(req)` first: a missing Origin is a local
  non-browser client and passes; a browser Origin must match
  `ALLOWED_ORIGIN` or a localhost origin on the known ports. Under the default
  `*` CORS this is what stops any page the user has open from reading their
  diagrams or writing their key. Preset *names*, never base URLs, are what the
  config route accepts from the browser for the same reason.

## The chat/agent wire format

`POST /api/ai/chat` is a pass-through to the provider's `/chat/completions`
with the allowlisted model's `maxTokens`. The browser drives the whole agent
loop (04); the request body is OpenAI's chat format with `tools`, and the
response is one assistant message, `{ message: { role, content, tool_calls? } }`.
The provider must support function/tool calling for the agent to work; the
one-shot and describe paths only need a vision-capable chat model.

Upstream calls abort when the client disconnects (Stop button, closed tab) and
time out after `AI_TIMEOUT_MS` (default 180s). The key-test route uses its own
10s timeout so a dead endpoint does not read as a hang.

## Client contract: `wireExcalidrawAI()`

`client.mjs` exports one entry point for embedding the AI in any app built on
`@excalidraw/excalidraw`:

    import { wireExcalidrawAI } from "./client.mjs";
    const ai = wireExcalidrawAI({
      excalidrawAPI,                 // required: the Excalidraw API instance
      endpoint: "/api/ai/diagram",   // all endpoints are overridable
      chatEndpoint: "/api/ai/chat",
      describeEndpoint: "/api/ai/describe",
      modelsEndpoint: "/api/ai/models",
      statusEndpoint: "/api/ai/status",
      configEndpoint: "/api/ai/config",
      testEndpoint: "/api/ai/test",
      chatsEndpoint: "/api/chats",
      onMessages,                    // optional: receives a slim transcript
      token: "",                     // optional bearer token for the API
      appendGap: 80,                 // px gap between generated blocks
    });

It returns the surface the host and any embedder uses:

- `refine()` - selected sketch (or selected text) -> clean diagram draft
- `generateFromText(text)` - text -> diagram draft
- `accept()` / `reject()` - commit or discard the current draft
- `tool(name, args)` - run a canvas tool directly, no model in the loop
- `agent.send(text, opts)` / `agent.reset()` / `agent.revert()` / `agent.load(messages)`
- `agent.models()` / `agent.status()` / `agent.test(opts)` / `agent.setup(opts)`
- `chats.list()` / `create()` / `read()` / `save()` / `remove()`
- `configure({ visionModel })`

The one-shot paths are stateless server calls; the agent keeps its transcript
in the browser (`agent.messages`) and hands `onMessages` a slim copy - chat
history, with any screenshots replaced by markers - which the host persists to
the chat store, so a reopened conversation resumes with the same model state.
