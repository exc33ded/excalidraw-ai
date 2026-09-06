# 02 - Chat panel UI

The AI panel is an Excalidraw `<Sidebar>` rendered inside `<Excalidraw>`, so
it inherits Excalidraw's chrome: header, dock/close buttons, fonts, dark mode.
It opens from the "AI" trigger (`AgentTrigger`) that `App.jsx` puts in
Excalidraw's top-right UI. Everything below lives in
`host/src/AgentPanel.jsx` and `host/src/App.jsx`.

The panel has three views - chat, history, settings - with a back button in
the header. Per-view header tools sit on the right of the title.

## Chat view

- **Header subtitle** is the live state line: `Assistant · deepseek-v4-flash`
  (mode · current model), or `no API key`, `models unavailable`, `loading
  models` / `no models`.
- **Header tools**: chats (history), undo ("Revert the last turn", shown only
  after a turn that changed the canvas and while not busy), clear
  conversation, and the settings gear.
- **Empty state**: the mode's hint plus clickable suggestion chips that fill
  the input (different suggestions per mode - canvas edits for Assistant,
  planning prompts for Guide, teaching topics for Tutor).
- **The log**: one bubble per message, styled by role - `user`, `assistant`,
  `note` ("Stopped.", "Reverted the last turn."), and `error` (the raw
  message from the server or client). Assistant replies render through a
  small markdown-lite pass (`renderLite`: `#` headings, `-`/`*` bullets,
  numbered lists, `**bold**`, `` `code` ``), and there is deliberately no
  markdown library.
- **Working indicator**: while a turn runs, a row shows the current step
  label - "thinking", then each tool name as it executes - with a Stop
  button that aborts the upstream call (the server aborts too when the
  connection drops).
- **Composer**: an auto-growing textarea (Enter sends, Shift+Enter newline)
  and a send button. A native wheel listener stops Excalidraw's canvas
  scroll from hijacking the textarea.

## Modes

Assistant / Guide / Tutor tabs sit above the composer (see 04 for what each
mode makes the model do). The mode is chosen per conversation but applied per
turn, so switching modes mid-conversation changes the next turn's system
prompt immediately. Mode, model picks, and docked state persist in
localStorage (`excalidraw-ai-settings`).

## History view: one chat per canvas

The chats list is the "hamburger" of this product. Every chat owns its own
canvas, and opening one brings its diagram back - the hint in the header says
so. Each row shows the title and last-updated date with an open and a delete
action; "+ New chat" is at the bottom. Deleting the active chat opens the
first remaining one, or creates a fresh one, so the app never ends up with no
canvas open.

Host-level persistence (`App.jsx`):

- The scene autosaves 500ms after the last change (`chats.save(id, { elements
  })`), with embedded files re-sent only when the image set actually changes
  (they are megabytes of base64).
- The display log and the model's own transcript are written together, as two
  views of one conversation, whenever the log changes - plus the canvas title.
  A freshly loaded chat is never re-saved (the "what we just read" guard).
- **Auto-title**: the first user message titles a "New chat" (first 60
  characters).
- The last active chat id is kept in localStorage and reopened on load.
- The display log persisted is capped at the last 200 messages with `error`
  bubbles excluded (they are transient); screenshots inside the model
  transcript are replaced by markers when it is handed over for storage.
- First run migrates the old single-canvas localStorage keys (scene, chat,
  messages) into chat #1 for returning users.

## Settings view (bring your own key)

- **Provider**: dropdown of the named presets the server offers (OpenAI,
  DeepSeek), plus "From bridge/.env" when a key is loaded from the
  environment and "Other (OpenAI-compatible)" for a custom endpoint. The
  explanatory text states where the current key came from (`.env` vs. saved)
  and shows its masked hint.
- **Custom endpoint**: a base URL field (must start with http/https, ends
  before `/chat/completions`). A custom endpoint must pass **Test
  connection** before Save is enabled - the test is where its model list
  comes from, since there is no preset to fall back on.
- **API key**: a password field with the provider's key page linked; Enter
  triggers Test. Leaving it empty reuses the already-loaded key ("switch
  provider, keep the key"). The .env entry is testable but never saveable -
  saving it would mean picking a preset for an endpoint the user chose by
  hand.
- **Test connection** proves the key and lists what the endpoint actually
  serves: usable models with `vision` / `reasoning` tags, how many non-chat
  models were hidden, and a plain-English read of the consequences ("No
  vision model here, so Refine and the capture tool will be unavailable";
  reasoning models get a 32k output budget). Nothing is saved until **Save**.
- **Model pickers** appear once a key is configured: Chat model (runs the
  agent loop and edits the canvas) and Vision model (reads screenshots for
  Refine and for the capture tool). If the chat model itself has vision, the
  panel notes that captures go to it directly.

## Footer bar (sketch path)

`App.jsx` renders a bar in Excalidraw's own `<Footer>` slot with the three
one-shot buttons: **Refine** (needs a selection; shows the count; title text
explains ctrl+A for everything), **Accept** and **Reject** (commit or discard
the generated draft). A transient "working..." note and error text appear
beside them while a one-shot path runs.
