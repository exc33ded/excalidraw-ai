# 07 - Vision & diagram paths

The one-shot paths turn a sketch (or a description) into a clean, editable
diagram in a single model call, as a *draft* you accept or reject. They are
stateless; everything the model needs is in one request. The chat agent's
whole-diagram tool is a different route to the same goal - see 04 and 08.

## Draft lifecycle

Every one-shot path produces a draft: `{ sourceIds, draftIds, sourceBbox,
mode }` where `mode` is `"sketch"` or `"text"`.

- **Accept** commits: in sketch mode it deletes the source elements and moves
  the draft into the source's place; in text mode it deletes whatever
  selection the text came from and keeps the generated diagram. Either way it
  is one `updateScene`, so one ctrl+Z undoes it.
- **Reject** removes the draft elements.
- Refining again while a draft exists simply adds another; the buttons operate
  on the latest.

## Sketch -> clean diagram (Refine)

`refine()` in `client.mjs`, gated on a selection (ctrl+A is the explicit way
to take the whole canvas - never redraw everything by accident):

1. If the selection (or a scene that is only text) reads as a text
   description, it becomes a text -> diagram generation instead
   (`textDescriptionOf`).
2. Otherwise the working set is the selection plus its 1-hop context
   (`expandSelection`, 06), rendered by `exportToBlob` as a PNG with the
   selection outlined blue and the context dimmed (`markElements`), text
   captions harvested as words.
3. `POST /api/ai/diagram` with the image (and the captions prompt) returns a
   validated element skeleton.
4. The client maps the skeleton onto a target rect beside the source
   (`mapToAbsolute`), gives every element a fresh unique id and rewrites
   arrow references (`normalizeIds`), snaps and routes arrows
   (`snapArrowEndpoints`, `positionBoundArrows`), converts to Excalidraw
   elements, and commits the draft.

The result preserves layout, not pixels: relative order, clusters, and
direction survive; the sketch itself is discarded on Accept.

## Text -> diagram

Two paths lead there:

- **`generateFromText(text)`** and a text-only Refine selection send the text
  to `/api/ai/diagram` with no image (`DIAGRAM_GENERATION_PROMPT`); the result
  is placed below the current scene (or below the source selection) and
  becomes a draft.
- **The agent's `create_diagram` tool** parses a mermaid definition in the
  browser with `@excalidraw/mermaid-to-excalidraw` - a deterministic layout
  engine (dagre) places everything, so boxes never overlap and no edge is
  forgotten. It is the model's mandated path for anything with more than four
  nodes or a name. Mermaid syntax errors come back verbatim so the model can
  correct itself.

## The output contract

Both the image and the text one-shot paths share one skeleton schema, defined
and enforced in `diagram-contract.mjs`:

- **Coordinates are relative fractions of the input image, 0..1** (x/y =
  top-left, width/height = size). The client maps them onto whatever target
  rect it chose, which is what keeps the model independent of export scale.
  The system prompt forbids pixel or canvas coordinates.
- Allowed types: `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`.
- A node is a shape with `label.text`; a connection is an arrow with
  `points` (relative) and optional `start`/`end` ids plus an optional edge
  `label`. Bound arrows must reference node ids the model itself chose.
- Hard limits: at most 64 elements, 500 characters per label, all numbers
  finite and inside [0,1]. The model must never drop a node it cannot read -
  best-guess labels are mandatory.
- `validateSkeleton()` runs server-side; a malformed or truncated answer is a
  422 with a reason, and a `finish_reason: length` is reported as an output
  budget problem ("raise maxTokens") rather than a malformed response.
- The model returns exactly one JSON object (`response_format json_object`),
  fenced output is stripped defensively.

## Words from an image (describe)

`/api/ai/describe` is the image-to-text counterpart: it takes a PNG data URL
and a question and returns a description (`DESCRIBE_SYSTEM_PROMPT`). The
agent's `capture` tool uses it when the turn's chat model has no vision; when
the chat model *is* vision-capable, the screenshot is delivered to the brain
directly as an image message (`detail: high`) instead - see 04.

## Relative coordinates and geometry repair

The vision model sees a rendering whose pixel size depends on export scale, so
absolute coordinates would be meaningless; the client owns placement. And
models routinely draw arrows that end inside boxes instead of naming them, so
every creation path repairs geometry (`snapArrowEndpoints` recovers bindings
from overlaps, `positionBoundArrows` runs arrows edge-to-edge on the dominant
axis, `convertToExcalidrawElements` is handed the existing referenced
elements so bindings actually resolve - 08).
