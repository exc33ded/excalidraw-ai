# 04 - Agent tools & runtime

The chat agent is a tool-calling loop. The persona and tool schemas live in
`agent-contract.mjs` (pure, no `@excalidraw` import, covered by the offline
tests); the implementations live in `client.mjs` against the live
`excalidrawAPI`.

## The persona

The system prompt tells the model it is editing an Excalidraw canvas of
elements (`rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`) with
position, size, colors, and arrow connections, and to work in a loop:
`query_elements` to inspect, then change, then reply briefly. The rules it
hammers on:

- **mermaid-first**: a whole diagram, anything with more than about four
  nodes, or anything with a name (transformer architecture, flowchart, CI
  pipeline, network, ER) must use `create_diagram` with mermaid - a layout
  engine places everything, so boxes never overlap and no connection is
  missed. Never hand-place a multi-node diagram.
- **layers, not hand-placed wiring**: connecting shapes that are already on
  the canvas into a network (neural network, feed-forward, pipeline) must use
  `connect_layers` with the nodes grouped into layers left to right. The tool
  cannot express a connection that skips a layer, which is the point.
- **A shape's text IS its label**: set it with `update_elements` on the shape;
  labels are never free-floating elements to create, move, or delete.
- Coordinates are absolute canvas pixels; new elements go near existing ones
  with a 20-40px gap; boxes stay roughly 120-160 x 60-80.
- Arrows reference element ids in `start`/`end`; a node an arrow will use gets
  a short unique id like `n1`.
- "These / this / the selected" means the current selection, whose ids are
  appended to every user message (06). Ambiguity -> one short question.
- `query_elements` answers in TOON, not JSON; read ids out of the first column.
- Treat the canvas as an existing document: reuse and edit, add only what was
  asked, and `set_view`/`capture` are available to see the canvas.

### Modes

`systemPromptFor(mode)` = the shared persona + a mode section, chosen per
turn, so switching mid-conversation takes effect immediately:

| Mode | Behavior |
| --- | --- |
| `assistant` | Edits the canvas on request; replies in 1-2 sentences. |
| `guide` | Plans with you: clarifying questions if vague, draws the plan with `create_diagram`, then replies with goal / phases / decisions / risks / next step. |
| `tutor` | Draws a learning roadmap first, teaches one step per turn with a diagram, and ends each teaching turn with a check question. |

## Tools

All eight are implemented with the semantics below (see the schemas in
`agent-contract.mjs` for the exact parameters):

| Tool | Purpose | Result shape |
| --- | --- | --- |
| `query_elements` | List canvas elements; `ids` or `filter` (substring over text/label/type) narrow it. Bound labels are folded into their container's row, never listed as free text. | TOON table + `total`, capped at 100 rows. |
| `create_elements` | Add shapes, text, and arrows that bind to element ids. | `{ created: [{ id, type }] }` |
| `update_elements` | Move/resize/restyle/relabel existing elements by id; only changed fields. | `{ updated: [{ id, ok, error? }] }` |
| `delete_elements` | Delete by id. | `{ deleted: [id] }` |
| `connect_layers` | Wire shapes already on the canvas into a layered network: arrange them into evenly spaced columns and connect each layer to the next one only. | `{ refined, arranged, connected, layers: [n] }` or `{ error }` |
| `create_diagram` | Whole laid-out diagram from a mermaid definition; new block beside existing content. | `{ created: N, bbox }` or `{ error }` (mermaid syntax error returned verbatim so the model can fix it) |
| `set_view` | Frame ids, the selection, or the whole canvas in the user's viewport. | `{ framed: N }` |
| `capture` | Render targets to PNG and *look*: how it actually renders, not coordinates. | `{ elements, width, height }` + a description (see below) |

### How the tools behave

- **Ids are never trusted.** `create_elements` assigns fresh ids (`ai` +
  random prefix + index) and rewrites arrow `start`/`end` to match, so new
  elements can never collide with the existing scene. `create_diagram`
  converts with `regenerateIds: true`, which rewrites arrow references too.
- **Arrows must be bound and positioned.** The converter only binds an arrow
  to elements in the same call, so `create_elements` hands it the existing
  elements the new arrows point at and merges back their updated copies
  (`boundElements` gains the arrow). `snapArrowEndpoints` recovers bindings by
  geometry when the model drew raw points inside boxes; `positionBoundArrows`
  runs every new arrow edge-to-edge on the dominant axis.
- **Labels are bound text elements.** Excalidraw keeps a shape's label in a
  separate text element with `containerId`; the model never sees that
  separation. `update_elements` text on a shape edits its bound label, moves
  the label when the container moves/resizes (`centeredLabelPosition`), and
  creates the bound text element when a container gets text for the first
  time. `delete_elements` takes the bound label with its container and strips
  dead `startBinding`/`endBinding`/`boundElements` references.
- **`connect_layers` owns the geometry, the model owns the grouping.** The
  model reads the nodes' coordinates and says which ids form which layer; the
  tool computes column and row spacing from the nodes' own size, moves them,
  and creates one arrow per adjacent-layer pair. A complete graph is
  unrepresentable in its arguments, because a prompt rule against it loses to
  a conversation whose own history already drew one. Hand-drawn `freedraw`
  blobs that are roughly round are re-created as ellipses first, keeping their
  ids: `freedraw` cannot hold an arrow binding, so lines drawn to a blob come
  loose the moment it is dragged. Arrowheads can be turned off, but the
  element is always an arrow, since only arrows bind.
- **`capture` has two brains.** When the turn's model has vision, the data URL
  is queued and delivered to the model as the next user image message (`detail:
  high`, "(canvas capture)"). When it does not, the client calls
  `/api/ai/describe` with the `question` and returns words.

## The loop

`agent.send(text, opts)` - `opts: { model, mode, signal, onStep }`:

1. Snapshot the whole scene (`agent.snapshot`) - one "revert this turn" step.
2. Set the per-turn mode system prompt; append selection ids + bbox and the
   viewport (scroll/zoom) to the user message; trim to the message budget.
3. Loop, at most 20 steps: call `/api/ai/chat` with the transcript and the
   eight tool schemas; if the reply has `tool_calls`, execute each tool
   (TOON/string results pass through; everything else is JSON), flush any
   queued capture images, and continue; otherwise return `{ reply, changed }`.
4. If the user pressed Stop, the fetch aborts (AbortSignal), and the partial
   turn is cut back to the last complete boundary (`dropIncompleteTurn`) so no
   tool call is ever orphaned from its result - upstream rejects that with a
   400. If 20 steps elapse, it replies that the canvas is partly changed and
   to say "continue".

The transcript is trimmed to a 120k-character budget (`MESSAGES_BUDGET`); the
system prompt and whole turns are dropped, oldest first, never a tool call
without its result. Tool results accumulate all conversation, which is why
`query_elements` answers in TOON: on a 79-element scene it measures ~50% fewer
characters than JSON, and it compounds.

`agent.revert()` restores the pre-turn snapshot (one level). `agent.reset()`
clears transcript and snapshot. `agent.load(messages)` restores a stored
conversation (no snapshot - a snapshot of another chat's canvas must never be
revertable here).
