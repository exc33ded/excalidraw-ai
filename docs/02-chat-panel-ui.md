# 02 - Chat panel UI

Where: src/client/app/canvas-agent-runtime.js

This is the right-side panel the user asked about. It is a resizable, draggable
overlay that holds the agent conversation.

## Layout and persistence

The panel position, size, and history survive reloads via localStorage keys
(canvas-agent-runtime.js lines 92-99):

    penecho-canvas-agent-session-v1
    penecho-canvas-agent-client-v1
    penecho-canvas-agent-position-v1
    penecho-canvas-agent-height-v1
    penecho-canvas-agent-width-v1
    penecho-canvas-agent-history-v1
    penecho-canvas-agent-search-enabled-v1
    penecho-canvas-agent-project-v1

## UI pieces

- Transcript: renders agent messages, copy blocks (code), copy buttons, and
  per-message feedback buttons (lines ~697-710).
- Prompt chips: suggested prompts keyed by category, including selection-aware
  ones: selectionVisual, selectionLayer, selectionPublish (lines 177-210).
- Projects: a project picker and file browser via /api/canvas-agent/projects and
  /api/canvas-agent/files (lines ~730, ~927).
- History: session history list (lines ~1383-1412).
- Empty state: canvasAgentRenderEmpty.

## Selection sync (the key part)

The panel is the thing that reads the user's selection and sends it to the
agent. The relevant state is packed into a "view facts" object (line ~2453):

    { scale, panX, panY, selection: { objectIds, inkBounds }, ... }

and the turn references include (line ~2488):

    selection: { objectIds: canvasAgentSelectionIds(), inkBounds: canvasAgentExternalRect(state.selection?.box) }

So: when the user selects (or lassos) objects, the chat captures those object
ids plus their bounding box, and they ride along with the next message. This is
what makes "reorganize these" / "make these blue" work. Details in
06-selection-and-context.md.

## How it maps to Excalidraw

- Replace the Penecho DOM panel with a React chat panel in bridge/host.
- Read selection from excalidrawAPI.getAppState().selectedElementIds instead of
  Penecho's state.selection.
- Ink bounds = bbox of the selected elements (we already have bboxOf).
