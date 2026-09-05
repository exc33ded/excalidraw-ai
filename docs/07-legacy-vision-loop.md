# 07 - Legacy one-shot vision loop

Where: src/server/main.js (SYSTEM_PROMPT ~line 1051, POST /api/ai/command)

This is the first AI path: render a crop of the canvas, ask one vision model
for one JSON response of commands. It is what our bridge already ports.

## Request

    POST /api/ai/command
    {
      model, stream: true, max_tokens, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [ {type:"text", text}, {type:"image_url",
                                     image_url:{url:atlasImage, detail:"high"}} ] }
      ]
    }

The image ("atlas") is a clean white-background rendering of confirmed canvas
content around the newest input. Metadata sent alongside:

    sourceRect        image's full-resolution global canvas rectangle
    imageScale        global units -> image pixels mapping
    latestInput.imageRect   authoritative attention region for this request
    hotspotGrid.hotspots    current unconsumed user-writing segment
    focusInset              magnified duplicate of latest handwriting (optional)
    selectionContext        user lasso rectangle (optional)

## SYSTEM_PROMPT essentials

    "You are the visual reasoning brain for a general interactive handwritten
     Q&A board ... Recognize and reason about handwritten natural-language
     questions (Chinese and English), mathematics, diagrams, charts, sketches,
     and mixed content."
    "Treat the canvas as an existing document to extend, not content to
     reproduce. Add only the missing continuation, answer, annotation, or new
     visual element; never rewrite ... content that is already present."
    "Whenever selectionContext is present, treat that lasso as the exclusive
     user-selected context for the request."

## Output commands

A JSON array of commands, among: draw, write_text, draw_formula, plot_function,
html_widget, diagram_source, widget_patch, animate_scene. Each carries
coordinates relative to the image (mapped back to global units via sourceRect /
imageScale).

## Status for us

Already ported to the bridge:

    bridge/diagram-contract.mjs  -> DIAGRAM_SYSTEM_PROMPT / DIAGRAM_GENERATION_PROMPT
    bridge/vision.mjs            -> buildVisionRequest / callVisionModel
    bridge/server.mjs            -> POST /api/ai/diagram (image or text)
    bridge/client.mjs            -> refine / accept / reject + working set

Difference: our port produces Excalidraw elements (rectangle/ellipse/diamond/
text/arrow/line) instead of Penecho's raster commands, and uses append-then-
accept semantics with a structural-1-hop working set.
