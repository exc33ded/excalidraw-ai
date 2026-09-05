# 08 - Penecho -> Excalidraw mapping

How to rebuild Penecho's main structure (the agent) on Excalidraw.

## Tool mapping

    Penecho tool                  Excalidraw equivalent
    ---------------------------   ------------------------------------------------
    canvas_inspect                query_elements: return getSceneElements() as
                                  JSON (id, type, text, x/y/w/h, bindings,
                                  groupIds, frameId) + selection + bbox
    canvas_read                   read_element: return one element's full JSON
    canvas_create                 create_elements: updateScene with new elements
    canvas_edit                   update_elements / delete_elements: updateScene
                                  with replaced/deleted elements
    canvas_set_view               set_view: scrollToContent / scrollToCoordinates
    canvas_capture                capture: exportToBlob -> image sent back so the
                                  model can verify its own edits
    canvas_revert                 revert: undo via excalidrawAPI's history
    canvas_patch_widget           (not needed; no widgets in v1)
    canvas_create/update_visual_explainer  (not needed; legacy)

## Execution model (must keep Penecho's invariant)

"Browser Canvas is authoritative." The Excalidraw scene lives in the browser
(host). The bridge server coordinates the agent loop but does not hold the
scene. So tool execution is either:

  A. Client-side loop: the chat panel runs the DeepSeek tool-calling loop and
     executes tools against excalidrawAPI directly. Simple, but the API key sits
     in the browser (bad) and model config is fixed client-side.

  B. Server-side loop (faithful to Penecho): the bridge server runs the loop;
     when the model calls an Excalidraw tool, the server returns the tool
     request to the browser, the browser executes it and posts the result back.
     Matches Penecho's open/frame/pull, keeps the key server-side.

Phase 1 uses a simplified B: each chat turn is a request/response cycle, and a
tool call is executed by the browser and returned in the same round trip (or a
short poll). We can graduate to a real WebSocket later if needed.

## Brain

DeepSeek tool-calling with deepseek-v4-flash (the flash model), via
bridge/server.mjs's POST /api/ai/chat proxy. Same final-vs-tool_call loop shape
as Penecho's CLI adapter, but an API instead of an external CLI. The key stays
in bridge/.env (AI_AGENT_MODEL=deepseek-v4-flash). flash is non-vision, so the
agent works on structured element JSON (query/create/update/delete) rather than
screenshots.

## Selection context

Send { objectIds: selectedElementIds, bbox } with every turn (reuse bboxOf from
bridge/geometry.mjs). This is the "when I select, the chat catches on" feature.

## Phases

    Phase 1: right-side chat panel + selection context + tool-calling agent with
             query_elements / create_elements / update_elements / delete_elements
             / capture / set_view.
    Phase 2: align / group, revert (undo), streaming responses, project/multi-file.
    Phase 3: visual-skills + professional diagram sources (mermaid -> Excalidraw)
             and HTML-widget equivalents, only if wanted.

## What already exists in the bridge

    bridge/server.mjs            one-shot POST /api/ai/diagram (image or text)
    bridge/diagram-contract.mjs  prompts + skeleton validation
    bridge/vision.mjs            OpenAI-compatible vision call
    bridge/geometry.mjs          bboxOf, expandSelection (1-hop), mapToAbsolute
    bridge/client.mjs            refine / accept / reject + working set
    bridge/host/src/App.jsx      test UI with AI refine / Accept / Reject buttons

The agent (Phase 1) adds a chat panel alongside these buttons and swaps the
one-shot call for a tool-calling loop.
