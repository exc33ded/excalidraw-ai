# excalidraw-ai

An AI agent inside Excalidraw. A chat sidebar that reads and edits the live
canvas through tools, generates whole diagrams from text via mermaid, cleans up
hand-drawn sketches with a vision model, and can act as an assistant, a
planning guide, or a step-by-step tutor.

Built on the `@excalidraw/excalidraw` npm package, not a fork. The product is
`bridge/`; nothing else is required to run it.

    bridge/          the app: Node proxy server + Vite/React host + agent client
    docs/            design notes, the Penecho reference study, and 09-handoff.md
                     (start there: what is built, what is proven, what is next)

## Run

    cd bridge
    cp .env.example .env         # put your OpenAI-compatible key in .env
    node server.mjs              # http://127.0.0.1:8787

    cd bridge/host
    npm install
    npm run dev                  # http://localhost:5173

Models the chat offers come from `AI_MODELS` in `bridge/.env`
(`id[:vision][:maxTokens]`, comma separated). See `bridge/README.md`.

## Test

    cd bridge
    node test.mjs                # offline, no key
    node browser-test.mjs        # headless Chrome, needs both servers and a key

## Reference clones (optional)

The docs cite two upstream repos by path. They are not part of this repo;
clone them beside `bridge/` if you want to follow the references:

    git clone https://github.com/excalidraw/excalidraw excalidraw
    git clone https://github.com/penecho/penecho penecho   # docs reference v1.2.0
