# 06 - Selection & context

Excalidraw's canvas is a shared document, and the agent's model never holds a
copy of it. Context is handed over in three complementary ways: what is
appended to each message, what a tool reads when it runs, and what the
one-shot sketch path renders into an image.

## Selection and viewport travel with every message

`agent.send` appends two bracketed blocks to the user's text before the model
sees it:

    [Canvas selection ids: ["a1b2", "c3d4"] bbox {"x":120,"y":80,"w":560,"h":200}]
    [Viewport: scroll 40,-20 zoom 1.00]

- Selection ids tell the model what "these / this / the selected" refers to -
  the system prompt instructs it to treat those words as the current
  selection.
- The bbox (rounded) and viewport (scroll offset + zoom) anchor the model's
  sense of where things are and what the user can see. `set_view` exists so
  the model can move that viewport.

The selection is a *hint about intent*, not a lock: `query_elements` reads the
live scene regardless of selection, and any tool can name ids directly.

## Tools fall back: ids -> selection -> whole canvas

`set_view` and `capture` share one target resolution (`targetElements`): use
the ids given; if none resolve, use the current selection (a container's
bound label counts with it); if nothing is selected, the whole canvas. This is
what makes "show me what I selected" and "look at the whole thing" both work
without the model knowing the ids.

`query_elements` takes ids or a text filter and returns rows from the live
scene (labels folded into their containers - see 04), so the model's view of
the canvas is always exactly what the canvas is when the tool runs.

## The one-shot sketch path

Refine renders *context*, not just the selection:

- `expandSelection` grows the selection to its 1-hop structural neighborhood:
  bound arrows and their far ends, whole groups, containing frames. The
  working set is what gets redrawn.
- `markElements` renders the selected elements with a thick blue outline and
  the surrounding context dimmed. The diagram prompt tells the model exactly
  what that means: regenerate every visible node/connection/label, preserve
  every dimmed element's label and connections (nudging positions is allowed).
- Text captions inside a sketch are pixels to the model, so `refine()` reads
  the working set's text elements and hands them over as words too ("The
  sketch carries this text: ... Treat it as the subject or caption...").
- Placement: the clean result is generated into a target rect beside the
  source bbox (`appendGap`), then Accept moves it into the source's place (07).

## What is not synced

- No lasso/region shape is sent - only ids + bbox of the selection.
- No per-state-change re-sync mid-turn: the agent never watches the canvas
  stream; it reads state when a tool runs, which is what keeps the browser
  authoritative and the protocol single-writer.
- No image attachments from the user in chat. Screenshots reach the brain
  only through the `capture` tool (or the vision model's chat flag), which
  keeps the transcript text-only except for intentional renders.

The absent pieces - a true region/lasso, user image attachments, live canvas
re-sync - are tracked as roadmap items in 09.

## Snapshot semantics

Before each agent turn the client snapshots the whole scene; `revert` puts it
back (one level, one undo step). A snapshot is never carried across chats:
`agent.load` restores a stored transcript with `snapshot = null`, because a
snapshot of another chat's canvas must never be revertable here.
