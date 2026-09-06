# 05 - Providers & the model brain

The "brain" is any OpenAI-compatible `/chat/completions` endpoint. The server
proxies to it, holds the key, and enforces the model allowlist. There is no
external CLI and no local model runtime to install.

## Presets

Two providers are offered by name in the settings screen
(`PROVIDER_PRESETS` in `agent-contract.mjs`):

| Provider | Base URL | Preset models |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini:16000`, `gpt-4o:vision:16000` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-v4-flash:reasoning`, `deepseek-v4-pro:reasoning`, `deepseek-v4-flash-vision-exp:vision:reasoning` |

Each preset carries its own model list, the default agent model, the default
vision model, and a link to the provider's key page. "Other (OpenAI-
compatible)" points at any endpoint that serves `/chat/completions` - a local
server, a proxy, any vendor - by base URL.

## The allowlist

`AI_MODELS` (in `bridge/.env`) lists the models the pickers offer, as
`id[:vision][:reasoning][:maxTokens]`, comma-separated:

    AI_MODELS=gpt-4o-mini:16000,gpt-4o:vision:16000

- `:vision` - the model can read images; it is offered in the vision picker
  (Refine and the capture tool) as well as the chat picker.
- `:reasoning` - the model spends output budget on reasoning tokens before
  emitting content; it needs a large `maxTokens`.
- `:maxTokens` - output budget. Defaults to 32000.
- The server **refuses any model not on the list** (a 400 on `/api/ai/chat`
  and `/api/ai/diagram` when a model is named that the list does not contain),
  so the browser can never name an arbitrary upstream model. To add a model,
  append it to the line and restart; no code change is needed.

The vision default (`AI_API_MODEL`) is always on the list and always flagged
vision; `AI_AGENT_MODEL` is the default chat model.

## Discovery (Test connection)

The settings screen does not trust its own guesses: one call to the
endpoint's `/models` proves the key and reports what it serves, and the
result **replaces** the preset's list rather than extending it.

`GET /v1/models` returns only `{ id, object, created, owned_by }` - no vision
flag, no reasoning flag, no token budget. So discovery supplies the candidate
ids and the merge (`mergeDiscoveredModels`) fills in what it can:

- Models that are plainly not chat models are dropped: embedding, whisper,
  TTS, dall-e, moderation, rerank, audio, realtime, speech, transcription.
- A preset's verified flags win for ids it knows.
- The rest are guessed from the id (`LOOKS_VISION` / `LOOKS_REASONING`) and
  given a conservative 8000-token budget, because 32000 is
  a 400 on most non-reasoning models, and a reasoning model that bills
  reasoning tokens against an 8k cap truncates mid-JSON (measured 2966-7897
  reasoning tokens on one short prompt). `REASONING_MAX_TOKENS` is 32000;
  discovered models that look reasoning get it.
- If nothing survives the filter the key-test reports 422: "the key works,
  but this endpoint serves no chat models" - including how many entries it
  saw, which usually means a key with the wrong scope or a non-chat product.

## Where the key lives

- **Precedence**: a key saved from the settings screen wins over `.env` - it
  is the one typed most recently. It persists to `bridge/config.json`
  (gitignored, written 0600) together with provider, base URL, and the
  model list. Delete `config.json` to fall back to `.env`.
- **The key never round-trips to the browser.** Status reports a masked hint
  only (last 4 characters). The browser sends a provider *name* on save, not
  a base URL; an empty key means "keep the one already loaded", which is how
  switching providers reuses the saved key. A discovered custom endpoint is
  the one case the browser does send a base URL - but only after the
  key-test proved it, and the config route rejects cross-origin writes (03).
- `AI_API_KEY` / `AI_API_URL` / `AI_API_MODEL` / `AI_AGENT_MODEL` set the
  same things from the environment; `AI_BRIDGE_HOST`, `AI_BRIDGE_TOKEN`,
  `ALLOWED_ORIGIN`, and `AI_TIMEOUT_MS` harden the server (03).

## Chat models and vision models

The product runs two kinds of model work:

1. **The agent brain** (`/api/ai/chat`): needs tool calling; text in and out.
2. **Vision work** (`/api/ai/diagram` and `/api/ai/describe`): needs an image-
   capable model (Refine, capture, sketch clean-up).

With no key, `/api/ai/models` returns an empty list and the vision routes say
so rather than offering ids the provider would 404 on. A chat model that is
also vision-capable collapses the two: the agent's `capture` tool hands the
screenshot straight to the brain instead of routing it through the separate
describe call (04).

## Testability

`node test.mjs` runs offline with no key: it exercises the contract and
geometry modules, model-list parsing, message trimming, and the tool schemas.
`node browser-test.mjs` drives a real Chrome against both servers with a real
key - the end-to-end agent gate (see 09).
