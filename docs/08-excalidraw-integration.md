# 08 - Excalidraw integration notes

Everything in this project runs against the `@excalidraw/excalidraw` npm
package rather than a fork of Excalidraw. These notes collect what that
integration required:
the pieces of the package the code leans on, and the element-model traps that
shaped the agent tools.

## The package surface used

- **`convertToExcalidrawElements(specs, { regenerateIds })`** - the only
  public way to turn element specs into live elements. It also creates bound
  text elements from `label: { text }` (see labels below) and binds arrows to
  `start`/`end` ids.
- **`exportToBlob`** - renders elements to an image. Every render the model
  will see pins a white background (`exportBackground: true,
  viewBackgroundColor: "#ffffff"`) and passes `files` so embedded images
  appear; the result becomes a base64 data URL.
- **`excalidrawAPI`** - `updateScene` (with `CaptureUpdateAction.IMMEDIATELY`
  everywhere, so the user sees each agent change), `getSceneElements`,
  `getAppState`, `getFiles`, `addFiles`, `scrollToContent`, `onChange`,
  `toggleSidebar`.
- **UI slots** - the AI panel is a `<Sidebar>` and must be a child of
  `<Excalidraw>`; the trigger is `<Sidebar.Trigger>` in `renderTopRightUI`;
  the one-shot buttons live in the native `<Footer>` slot. Excalidraw renders
  one sidebar at a time (opening Library closes the AI panel).
- **`@excalidraw/mermaid-to-excalidraw`** - `parseMermaidToExcalidraw` for
  the `create_diagram` tool. It is imported lazily on the first call -
  mermaid is large, and Excalidraw itself lazy-loads it for the same reason.
  `regenerateIds: true` on conversion rewrites the skeletons' arrow
  references, so bound arrows survive and ids never collide with the scene.

## The element model, and what it did to the tools

Excalidraw's scene model has three properties that leak into every design
decision here:

1. **A shape's label is a separate text element.** It has `containerId`
   pointing at its container; the shape itself carries no `label`. The model
   is told the opposite - "a shape's text IS its label" - and the tools
   translate:
   - `update_elements` text on a container edits its bound text element, moves
     the label when the container moves or resizes (`centeredLabelPosition`),
     and creates the bound text element the first time a container gets text.
   - `delete_elements` takes the bound label with its container.
   - `query_elements` folds labels into their container's row so the model
     never sees a free-floating label it might move or delete.
   - Creating a bound label for the first time runs the container through
     `convertToExcalidrawElements` with a `label` and keeps just the text
     element it produces - the converter is the only public way to make one.
2. **Arrows bind to ids, but only within one conversion call.** The converter
   refuses to bind an arrow to an element outside the call, so `create_elements`
   hands it the existing scene elements the new arrows point at and merges
   back their updated copies (`boundElements` gains the arrow). Binding and
   geometry are separate: the converter binds but never positions, so arrows
   given only ids have no `x`/`y`; `positionBoundArrows` runs every new arrow
   edge-to-edge on the dominant axis, and `snapArrowEndpoints` recovers
   bindings from geometry when a model drew raw points inside boxes (explicit
   `start`/`end` always win). Deleting cleans up: dead `startBinding` /
   `endBinding` and `boundElements` references are stripped.
3. **Ids are global and user-visible.** Every creation path assigns fresh
   unique ids: the one-shot paths rewrite the model's skeleton ids
   (`normalizeIds`, then `regenerateIds: false` so the rewritten references
   survive conversion); `create_elements` prefixes ids with a random `ai…`
   stamp; `create_diagram` uses `regenerateIds: true`. Nothing the model
   names is ever trusted onto the canvas.

## Coordinate systems

- The vision skeleton contract is **relative fractions of the input image**
  0..1 (07), because the model sees a rendering whose pixel size depends on
  export scale. `mapToAbsolute` maps a skeleton onto a target rect the client
  chose: beside the source for Refine, below the scene for text generation,
  with `appendGap` (80px) of separation.
- The agent tools speak **absolute canvas pixels**, the scene's native units.

## Images and files

`excalidrawAPI.updateScene` does not carry files, so anything that embeds an
image must also call `addFiles`: `create_diagram` does this for mermaid
definitions that reference images (`parsed.files`), and chat switching does it
for stored scenes. `exportToBlob` gets `files` so captures and Refine renders
include embedded images. In storage, files travel separately too (see 09).

## Persistence shape

A chat's `scene.json` is exactly the canvas element array (deleted elements
filtered out at save time); reopening a chat hands it back to the canvas
together with the conversation and the model transcript, which must all swap
together or the next turn answers with the previous chat's history. The scene
autosaves on a 500ms debounce, the image set only when it changes.

## Keeping the contract testable

`agent-contract.mjs`, `geometry.mjs`, and `diagram-contract.mjs` never import
`@excalidraw/*`, so the offline suite (`test.mjs`) can check the persona,
schemas, geometry, and skeleton validation in plain Node with no browser and
no DOM. Only the tool implementations need the live `excalidrawAPI`, and they
are exercised by the second test layer (`browser-test.mjs`). In dev builds
`window.excalidrawAPI` and `window.ai` are exposed so `ai.tool(name, args)`
runs a canvas tool with no model in the loop - the fastest way to isolate a
converter or geometry bug.
