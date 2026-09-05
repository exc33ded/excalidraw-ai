# 06 - Selection and context flow

This is the mechanism behind "when I select, the chat catches on."

## Client side (src/client/app/canvas-agent-runtime.js)

The chat panel builds a viewport signature and selection object each time state
changes:

    line 2453: signature = { scale, panX, panY, selection, ... }
    line 2488: selection: { objectIds: canvasAgentSelectionIds(),
                            inkBounds: canvasAgentExternalRect(state.selection?.box) }
    line 2502: const objectIds = canvasAgentReferencedIds(), region = state.selection?.box
    line 439 : scope returns "selection" when referencedIds or a selection box exist

So the agent receives, with every turn:

    references: {
      selection: { objectIds: [...], inkBounds: {...} },
      viewport:  { scale, panX, panY },
      region:    {...}                    // lasso rectangle, if any
    }

## Server side (src/server/canvas-agent/runtime.mjs)

The server folds those references into the session:

- stateDigest = authoritative canvas JSON (bounded 20k chars, marked untrusted).
- referenceScope = { revision, viewRevision, objectIds, region, attachmentIds }.

Tools can then act on the selection scope:

- canvas_inspect accepts scope 'selection' and filters results to selected ids
  (client lines 3813-3827: "if scope === 'selection' and not selected -> skip").
- canvas_set_view accepts scope 'selection' to frame the selected objects.

## Legacy loop also had selection

The one-shot vision path (src/server/main.js) passes a selectionContext lasso,
and the prompt says: "Whenever selectionContext is present, treat that lasso as
the exclusive user-selected context for the request."

## How this maps to Excalidraw

Replace Penecho's state.selection with:

    excalidrawAPI.getAppState().selectedElementIds

and the ink bounds with the bbox of those elements (bridge/geometry.mjs already
has bboxOf). Send { objectIds, bbox } with every chat turn so the model can
resolve "these" / "that" / "the selected nodes".
