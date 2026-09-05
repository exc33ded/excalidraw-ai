// Drop-in client glue for an app built on @excalidraw/excalidraw.
//
//   import { wireExcalidrawAI } from "./bridge/client.mjs";
//   const ai = wireExcalidrawAI({ excalidrawAPI });
//   await ai.refine();                  // selected text -> diagram, or marked sketch -> clean diagram
//   await ai.generateFromText("...");   // explicit text -> diagram (no selection needed)
//   await ai.agent.send("add two nodes"); // chat agent (deepseek-v4-flash) with canvas tools
//   ai.accept();                        // replace the working set (one undo step)
//   ai.reject();                        // drop the generated draft
//
// Modes:
//   - text: a text description -> diagram (from selected text or an explicit string).
//   - sketch: the selection + its structural 1-hop neighbors is rendered as a
//     marked image (selection outlined, context dimmed); the model regenerates
//     the whole working set. Accept replaces the working set.
//   - agent: a tool-calling chat loop that inspects and edits the live canvas.

import { convertToExcalidrawElements, exportToBlob, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { encode as toonEncode } from "@toon-format/toon";
import { AGENT_TOOLS, systemPromptFor, trimMessages, dropIncompleteTurn } from "./agent-contract.mjs";
import { bboxOf, mapToAbsolute, normalizeIds, textDescriptionOf, expandSelection, labelIndex, isBoundLabel, summarizeElement, centeredLabelPosition, toQueryRows, positionBoundArrows, snapArrowEndpoints } from "./geometry.mjs";

// ---------------------------------------------------------------------------
// Agent (chat) definition. The loop runs here (browser), the model call is
// proxied through the server so the key stays server-side.
// ---------------------------------------------------------------------------

function blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// mark the working set: selected = thick blue outline, context = dimmed
function markElements(elements, selectedIds, hasSelection) {
  if (!hasSelection) return elements;
  return elements.map(function (e) {
    const c = Object.assign({}, e);
    if (selectedIds.has(e.id)) {
      c.strokeColor = "#1971c2";
      c.strokeWidth = Math.max(e.strokeWidth || 2, 4);
    } else {
      c.opacity = 30;
    }
    return c;
  });
}

// always assign fresh unique ids and rewrite arrow start/end references,
// so new elements never collide with existing scene ids
function assignFreshIds(specs) {
  const prefix = "ai" + Math.random().toString(36).slice(2, 8);
  const idOf = new Map();
  specs.forEach(function (s, i) { idOf.set(s.id, prefix + i); });
  return specs.map(function (s, i) {
    const out = Object.assign({}, s, { id: prefix + i });
    if (out.start && out.start.id) out.start = Object.assign({}, out.start, { id: idOf.get(out.start.id) || out.start.id });
    if (out.end && out.end.id) out.end = Object.assign({}, out.end, { id: idOf.get(out.end.id) || out.end.id });
    return out;
  });
}

// query results accumulate every turn; past this the oldest turns are dropped whole
const MESSAGES_BUDGET = 120000;

export function wireExcalidrawAI({ excalidrawAPI, endpoint = "/api/ai/diagram", chatEndpoint = "/api/ai/chat", describeEndpoint = "/api/ai/describe", modelsEndpoint = "/api/ai/models", statusEndpoint = "/api/ai/status", configEndpoint = "/api/ai/config", testEndpoint = "/api/ai/test", chatsEndpoint = "/api/chats", onMessages, token = "", appendGap = 80 }) {
  let draft = null; // { sourceIds:Set, draftIds:Set, sourceBbox, mode:"sketch"|"text" }
  const agent = { messages: [], snapshot: null }; // snapshot = scene before the last turn
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const prefs = { visionModel: "" }; // set by the panel's settings view; "" = server default

  // The transcript belongs to whichever chat is open, so persisting it is the
  // host's job now (it knows the chat id); this only hands over the slim copy.
  function saveMessages() {
    if (!onMessages) return;
    // screenshots handed to a vision brain are megabytes of base64; keep a marker only
    onMessages(agent.messages.slice(1).map(function (m) {
      return Array.isArray(m.content) ? Object.assign({}, m, { content: "[image omitted]" }) : m;
    }));
  }

  // swap in a stored conversation. The system prompt is always rebuilt from
  // source, so a prompt edit reaches returning users.
  function agentLoad(messages) {
    const past = Array.isArray(messages) ? messages.filter(function (m) { return m.role !== "system"; }) : [];
    agent.messages = past.length ? [{ role: "system", content: systemPromptFor("assistant") }].concat(past) : [];
    agent.snapshot = null; // a snapshot of another chat's canvas must never be revertable here
  }

  function sceneElements() {
    return excalidrawAPI.getSceneElements();
  }

  function selectedElements() {
    const elements = sceneElements();
    const appState = excalidrawAPI.getAppState();
    const sel = appState.selectedElementIds;
    if (sel && Object.keys(sel).length) {
      const chosen = elements.filter(function (e) { return sel[e.id]; });
      if (chosen.length) return { elements: chosen, appState, hasSelection: true };
    }
    return { elements: elements, appState, hasSelection: false };
  }

  async function post(body) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(Object.assign({ model: prefs.visionModel || undefined }, body)),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || ("request failed " + res.status));
    }
    const json = await res.json();
    if (!Array.isArray(json.elements)) throw new Error("no elements returned");
    return json.elements;
  }

  async function postChat(messages, tools, model, signal) {
    const res = await fetch(chatEndpoint, {
      method: "POST",
      headers: headers,
      signal: signal,
      body: JSON.stringify({ messages: messages, tools: tools, model: model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || ("chat failed " + res.status));
    }
    const json = await res.json();
    if (!json.message) throw new Error("no assistant message returned");
    return json.message;
  }

  // The agent brain (deepseek-v4-flash) is not a vision model, so `capture`
  // routes the screenshot through the vision model on the server and hands the
  // agent a written description instead of pixels.
  // A model flagged :vision in AI_MODELS skips this hop: the tool result is
  // followed by a user message carrying the image (tool messages are text-only).
  async function postDescribe(image, question, signal) {
    const res = await fetch(describeEndpoint, {
      method: "POST",
      headers: headers,
      signal: signal,
      body: JSON.stringify({ image: image, question: question || "", model: prefs.visionModel || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || ("describe failed " + res.status));
    }
    const json = await res.json();
    return json.description || "";
  }

  function commit(elements, sourceIds, sourceBbox, mode) {
    const current = sceneElements();
    excalidrawAPI.updateScene({ elements: current.concat(elements), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    draft = {
      sourceIds: new Set(sourceIds),
      draftIds: new Set(elements.map(function (e) { return e.id; })),
      sourceBbox: sourceBbox,
      mode: mode,
    };
    return elements;
  }

  async function generateDiagramFromText(desc, sourceElements, placementElements) {
    const skeleton = await post({ text: desc });
    const place = placementElements && placementElements.length ? placementElements : (sourceElements || []);
    const placeBbox = bboxOf(place);
    const target = {
      x: placeBbox ? placeBbox.x : 0,
      y: placeBbox ? placeBbox.y + placeBbox.height + 160 : 0,
      width: 900,
      height: 640,
    };
    const newElements = convertToExcalidrawElements(positionBoundArrows(normalizeIds(mapToAbsolute(skeleton, target))), { regenerateIds: false });
    return commit(newElements, (sourceElements || []).map(function (e) { return e.id; }), placeBbox, "text");
  }

  async function refine() {
    const { elements, appState, hasSelection } = selectedElements();
    // never redraw the whole canvas by accident: ctrl+A is the explicit way
    if (!hasSelection) throw new Error("select the sketch to refine first (ctrl+A for everything)");

    // text -> diagram (selected text, or a scene that is only text)
    const desc = textDescriptionOf(elements);
    if (desc !== null) {
      return generateDiagramFromText(desc, elements, elements);
    }

    // sketch -> diagram: working set = selection + 1-hop context, marked image
    // (selected outlined, context dimmed; the model redraws the whole working set)
    const all = sceneElements();
    const workingSetIds = expandSelection(elements, all);
    const workingSet = all.filter(function (e) { return workingSetIds.has(e.id); });
    const selectedIds = new Set(elements.map(function (e) { return e.id; }));
    const sourceBbox = bboxOf(workingSet);
    if (!sourceBbox) throw new Error("nothing to work on - select elements or type a text description");

    let blob;
    try {
      blob = await exportToBlob({
        elements: markElements(workingSet, selectedIds, hasSelection),
        appState: Object.assign({}, appState, { exportBackground: true, viewBackgroundColor: "#ffffff" }),
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
    } catch (e) {
      throw new Error("could not render the canvas to an image: " + (e && e.message ? e.message : String(e)) + ". Try selecting fewer elements, or type a text description.");
    }

    const dataURL = await blobToDataURL(blob);
    if (typeof dataURL !== "string" || dataURL.indexOf("data:image/") !== 0) {
      throw new Error("the canvas export was not a valid image (got: " + String(dataURL).slice(0, 40) + "...). Type a text description instead.");
    }

    // captions inside the sketch are pixels to the model; hand them over as words
    // too, so "neural network" under a scribble shapes what gets drawn
    const captions = workingSet
      .filter(function (e) { return e.type === "text" && e.text && e.text.trim(); })
      .map(function (e) { return e.text.trim(); });
    const skeleton = await post({
      image: dataURL,
      prompt: captions.length ? "The sketch carries this text: " + JSON.stringify(captions) + ". Treat it as the subject or caption of the drawing: draw a clean version of what it names, using the sketch for layout and structure, and label the nodes as that subject would label them." : undefined,
    });

    const target = {
      x: sourceBbox.x + sourceBbox.width + appendGap,
      y: sourceBbox.y,
      width: sourceBbox.width,
      height: sourceBbox.height,
    };
    const newElements = convertToExcalidrawElements(positionBoundArrows(normalizeIds(mapToAbsolute(skeleton, target))), { regenerateIds: false });
    return commit(newElements, Array.from(workingSetIds), sourceBbox, "sketch");
  }

  async function generateFromText(text) {
    const prompt = (text || "").trim();
    if (!prompt) throw new Error("type a description first");
    return generateDiagramFromText(prompt, [], sceneElements());
  }

  function reject() {
    if (!draft) return;
    const current = sceneElements();
    excalidrawAPI.updateScene({
      elements: current.filter(function (e) { return !draft.draftIds.has(e.id); }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    draft = null;
  }

  function accept() {
    if (!draft) return;
    const current = sceneElements();
    if (draft.mode === "text") {
      excalidrawAPI.updateScene({
        elements: current.filter(function (e) { return !draft.sourceIds.has(e.id); }),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      draft = null;
      return;
    }
    const draftEls = current.filter(function (e) { return draft.draftIds.has(e.id); });
    const keep = current.filter(function (e) { return !draft.sourceIds.has(e.id) && !draft.draftIds.has(e.id); });
    const draftBbox = bboxOf(draftEls);
    let moved = draftEls;
    if (draftBbox && draft.sourceBbox) {
      const dx = draft.sourceBbox.x - draftBbox.x;
      const dy = draft.sourceBbox.y - draftBbox.y;
      moved = draftEls.map(function (e) { return Object.assign({}, e, { x: e.x + dx, y: e.y + dy }); });
    }
    excalidrawAPI.updateScene({ elements: keep.concat(moved), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    draft = null;
  }

  // --------------------------- agent (chat) ---------------------------

  function runQuery(args) {
    const all = sceneElements();
    const labels = labelIndex(all);
    // a shape's label is a bound text element; showing it separately would make
    // the model think every label is a free-floating element it can move or delete
    let list = all.filter(function (e) { return !isBoundLabel(e); });
    const ids = args && Array.isArray(args.ids) && args.ids.length ? new Set(args.ids) : null;
    const filter = args && typeof args.filter === "string" ? args.filter.toLowerCase() : "";
    if (ids) list = list.filter(function (e) { return ids.has(e.id); });
    if (filter) {
      list = list.filter(function (e) {
        const s = summarizeElement(e, labels);
        return ((s.text || "") + " " + e.type).toLowerCase().indexOf(filter) >= 0;
      });
    }
    // TOON instead of JSON: the scene is a uniform array of records, which is
    // exactly the shape TOON collapses into a header plus bare rows. Measured
    // ~50% fewer characters on a 79-element scene, and query results accumulate
    // in agent.messages for the whole conversation, so it compounds.
    return toonEncode({ elements: toQueryRows(list.slice(0, 100), labels), total: list.length });
  }

  function coerceSpec(spec) {
    const out = Object.assign({}, spec);
    if (typeof out.start === "string") out.start = { id: out.start };
    if (typeof out.end === "string") out.end = { id: out.end };
    if (out.type === "text") {
      delete out.label;
      if (typeof out.width !== "number") out.width = 160;
      if (typeof out.height !== "number") out.height = 40;
    } else if (typeof out.text === "string") {
      out.label = Object.assign({}, out.label, { text: out.text });
      delete out.text;
    }
    if ((out.type === "rectangle" || out.type === "ellipse" || out.type === "diamond") && typeof out.width !== "number") {
      out.width = 140;
      out.height = 80;
    }
    return out;
  }

  function runCreate(args) {
    const specs = Array.isArray(args && args.elements) ? args.elements : [];
    if (!specs.length) return { created: [] };
    const coerced = specs.map(coerceSpec);
    const fresh = assignFreshIds(coerced);
    const current = sceneElements();
    const specsReady = positionBoundArrows(snapArrowEndpoints(fresh, current), current);
    // The converter binds an arrow only to elements in the same call, so hand
    // it the scene elements the new arrows point at and take back their
    // updated copies (boundElements gains the arrow). Without this every arrow
    // to an existing box silently lost its binding.
    const newIds = new Set(specsReady.map(function (s) { return s.id; }));
    const byId = new Map(current.map(function (e) { return [e.id, e]; }));
    const referenced = new Map();
    specsReady.forEach(function (s) {
      [s.start, s.end].forEach(function (ref) {
        const id = ref && ref.id;
        if (id && !newIds.has(id) && byId.has(id)) referenced.set(id, byId.get(id));
      });
    });
    const out = convertToExcalidrawElements(Array.from(referenced.values()).concat(specsReady), { regenerateIds: false });
    const created = out.filter(function (e) { return !referenced.has(e.id); });
    const touched = new Map(out.filter(function (e) { return referenced.has(e.id); }).map(function (e) { return [e.id, e]; }));
    const merged = current.map(function (e) { return touched.get(e.id) || e; }).concat(created);
    excalidrawAPI.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return { created: created.map(function (e) { return { id: e.id, type: e.type }; }) };
  }

  function runUpdate(args) {
    const changes = Array.isArray(args && args.changes) ? args.changes : [];
    const current = sceneElements();
    const byId = new Map(current.map(function (e) { return [e.id, e]; }));
    const labels = labelIndex(current);
    const results = [];

    // Pass 1: the addressed elements. Collect the label edits their containers imply.
    const labelEdits = new Map(); // bound text id -> { text?, x?, y? }
    const newLabels = []; // [containerId, text] for containers that have no label yet
    const next = current.map(function (e) {
      const c = changes.find(function (ch) { return ch.id === e.id; });
      if (!c) return e;
      const merged = Object.assign({}, e);
      ["x", "y", "width", "height", "strokeColor", "backgroundColor", "fillStyle"].forEach(function (k) {
        if (typeof c[k] === "number" || typeof c[k] === "string") merged[k] = c[k];
      });
      if (typeof c.text === "string") {
        if (e.type === "text") { merged.text = c.text; merged.originalText = c.text; }
      }
      const label = labels.get(e.id);
      if (label) {
        const edit = {};
        // text on a container means the text of its bound label
        if (typeof c.text === "string") { edit.text = c.text; edit.originalText = c.text; }
        // a moved or resized container drags its label along
        const moved = merged.x !== e.x || merged.y !== e.y || merged.width !== e.width || merged.height !== e.height;
        if (moved) {
          const pos = centeredLabelPosition(label, merged);
          if (pos) { edit.x = pos.x; edit.y = pos.y; }
        }
        if (Object.keys(edit).length) labelEdits.set(label.id, edit);
      } else if (typeof c.text === "string" && e.type !== "text" && c.text.trim()) {
        newLabels.push([e.id, c.text]);
      }
      results.push({ id: e.id, ok: true });
      return merged;
    });

    // Pass 2: apply them to the bound text elements themselves.
    const withLabels = labelEdits.size
      ? next.map(function (e) { const edit = labelEdits.get(e.id); return edit ? Object.assign({}, e, edit) : e; })
      : next;

    // Pass 3: containers that got text but had no label. The converter is the
    // only public way to make a bound text element, so run the container
    // through it with a label and keep just the text it produces.
    let final = withLabels;
    if (newLabels.length) {
      const nextById = new Map(final.map(function (e) { return [e.id, e]; }));
      const added = [];
      newLabels.forEach(function (pair) {
        const container = nextById.get(pair[0]);
        const made = convertToExcalidrawElements([Object.assign({}, container, { label: { text: pair[1] } })], { regenerateIds: false });
        const text = made.find(function (m) { return m.type === "text" && m.containerId === container.id; });
        const shell = made.find(function (m) { return m.id === container.id; });
        if (!text || !shell) return;
        nextById.set(container.id, Object.assign({}, container, { boundElements: (container.boundElements || []).concat([{ type: "text", id: text.id }]) }));
        added.push(text);
      });
      final = final.map(function (e) { return nextById.get(e.id) || e; }).concat(added);
    }

    changes.forEach(function (c) { if (!byId.has(c.id)) results.push({ id: c.id, ok: false, error: "not found" }); });
    excalidrawAPI.updateScene({ elements: final, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return { updated: results };
  }

  function runDelete(args) {
    const ids = new Set(Array.isArray(args && args.ids) ? args.ids : []);
    const current = sceneElements();
    // a deleted shape takes its bound label with it, otherwise the label is
    // orphaned and renders as a stray floating text
    for (const e of current) {
      if (isBoundLabel(e) && ids.has(e.containerId)) ids.add(e.id);
    }
    const deleted = current.filter(function (e) { return ids.has(e.id); }).map(function (e) { return e.id; });
    const cleaned = current
      .filter(function (e) { return !ids.has(e.id); })
      .map(function (e) {
        let out = e;
        if (out.startBinding && ids.has(out.startBinding.elementId)) out = Object.assign({}, out, { startBinding: null });
        if (out.endBinding && ids.has(out.endBinding.elementId)) out = Object.assign({}, out, { endBinding: null });
        if (Array.isArray(out.boundElements)) out = Object.assign({}, out, { boundElements: out.boundElements.filter(function (b) { return !ids.has(b.id); }) });
        return out;
      });
    excalidrawAPI.updateScene({ elements: cleaned, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return { deleted: deleted };
  }

  // ids -> selection -> whole canvas, the fallback chain set_view and capture share
  function targetElements(args) {
    const all = sceneElements();
    const ids = args && Array.isArray(args.ids) && args.ids.length ? new Set(args.ids) : null;
    if (ids) {
      const chosen = all.filter(function (e) { return ids.has(e.id) || (isBoundLabel(e) && ids.has(e.containerId)); });
      if (chosen.length) return chosen;
    }
    const sel = excalidrawAPI.getAppState().selectedElementIds || {};
    const selected = all.filter(function (e) { return sel[e.id] || (isBoundLabel(e) && sel[e.containerId]); });
    return selected.length ? selected : all;
  }

  // Whole-diagram creation. A language model placing x/y by hand produces
  // arrows through boxes and forgotten edges; mermaid's layout engine (dagre,
  // already shipped inside @excalidraw/mermaid-to-excalidraw) does not. Mermaid
  // is also the diagram notation models write best.
  async function runCreateDiagram(args) {
    const source = args && typeof args.mermaid === "string" ? args.mermaid.trim() : "";
    if (!source) return { error: "mermaid definition required" };

    let parsed;
    try {
      // loaded on demand: mermaid is large, and Excalidraw lazy-loads it for the same reason
      const mod = await import("@excalidraw/mermaid-to-excalidraw");
      parsed = await mod.parseMermaidToExcalidraw(source);
    } catch (e) {
      // hand the syntax error back verbatim so the model can correct itself
      return { error: "mermaid could not be parsed: " + (e && e.message ? e.message : String(e)) };
    }

    // regenerateIds:true also rewrites the skeletons' start/end references, so
    // arrows stay bound and no id collides with the existing scene
    const converted = convertToExcalidrawElements(parsed.elements, { regenerateIds: true });
    if (!converted.length) return { error: "that definition produced no elements" };

    const current = sceneElements();
    const sceneBox = bboxOf(current);
    const diagramBox = bboxOf(converted);
    let placed = converted;
    if (sceneBox && diagramBox) {
      const dx = sceneBox.x + sceneBox.width + appendGap - diagramBox.x;
      const dy = sceneBox.y - diagramBox.y;
      placed = converted.map(function (e) { return Object.assign({}, e, { x: e.x + dx, y: e.y + dy }); });
    }

    if (parsed.files && Object.keys(parsed.files).length) {
      excalidrawAPI.addFiles(Object.values(parsed.files));
    }
    excalidrawAPI.updateScene({ elements: current.concat(placed), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    excalidrawAPI.scrollToContent(placed, { fitToContent: true, animate: true });

    const box = bboxOf(placed);
    return {
      created: placed.length,
      bbox: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
    };
  }

  function runSetView(args) {
    const targets = targetElements(args);
    if (!targets.length) return { error: "canvas is empty" };
    excalidrawAPI.scrollToContent(targets, { fitToContent: true, animate: true });
    return { framed: targets.length };
  }

  async function runCapture(args, turn) {
    const targets = targetElements(args);
    if (!targets.length) return { error: "canvas is empty" };
    const box = bboxOf(targets);
    const blob = await exportToBlob({
      elements: targets,
      appState: Object.assign({}, excalidrawAPI.getAppState(), { exportBackground: true, viewBackgroundColor: "#ffffff" }),
      files: excalidrawAPI.getFiles(),
      mimeType: "image/png",
    });
    const dataURL = await blobToDataURL(blob);
    const out = { elements: targets.length, width: box ? Math.round(box.width) : 0, height: box ? Math.round(box.height) : 0 };
    if (turn.vision) {
      turn.images.push(dataURL);
      out.note = "the rendered image follows in the next message";
      return out;
    }
    out.description = await postDescribe(dataURL, args && args.question, turn.signal);
    return out;
  }

  function executeTool(name, args, turn) {
    if (name === "query_elements") return runQuery(args);
    if (name === "create_elements") return runCreate(args);
    if (name === "update_elements") return runUpdate(args);
    if (name === "delete_elements") return runDelete(args);
    if (name === "create_diagram") return runCreateDiagram(args); // async
    if (name === "set_view") return runSetView(args);
    if (name === "capture") return runCapture(args, turn); // async: awaited by the caller
    return { error: "unknown tool " + name };
  }

  // opts: { model: { id, vision }, mode: "assistant"|"guide"|"tutor", signal: AbortSignal, onStep(label) }
  async function agentSend(text, opts) {
    const o = opts || {};
    const message = (text || "").trim();
    if (!message) throw new Error("type a message first");
    const turn = { signal: o.signal, vision: !!(o.model && o.model.vision), images: [] };
    const onStep = typeof o.onStep === "function" ? o.onStep : function () {};

    const all = sceneElements();
    const appState = excalidrawAPI.getAppState();
    const sel = appState.selectedElementIds || {};
    const selected = all.filter(function (e) { return sel[e.id]; });
    const selBbox = bboxOf(selected);
    // one "revert turn" instead of one ctrl+Z per updateScene
    agent.snapshot = all;

    // the system prompt follows the mode picked for THIS turn, so switching
    // modes mid-conversation takes effect immediately
    const system = { role: "system", content: systemPromptFor(o.mode) };
    if (!agent.messages.length) agent.messages.push(system);
    else agent.messages[0] = system;

    let userContent = message;
    if (selected.length) {
      const box = selBbox ? { x: Math.round(selBbox.x), y: Math.round(selBbox.y), w: Math.round(selBbox.width), h: Math.round(selBbox.height) } : null;
      userContent += "\n\n[Canvas selection ids: " + JSON.stringify(selected.map(function (e) { return e.id; })) + (box ? " bbox " + JSON.stringify(box) : "") + "]";
    }
    userContent += "\n[Viewport: scroll " + Math.round(appState.scrollX) + "," + Math.round(appState.scrollY) + " zoom " + (appState.zoom && appState.zoom.value ? appState.zoom.value.toFixed(2) : "1") + "]";
    agent.messages.push({ role: "user", content: userContent });
    agent.messages = trimMessages(agent.messages, MESSAGES_BUDGET);

    try {
      for (let step = 0; step < 20; step++) {
        onStep("thinking");
        const msg = await postChat(agent.messages, AGENT_TOOLS, o.model && o.model.id, turn.signal);
        agent.messages.push(msg);
        if (msg.tool_calls && msg.tool_calls.length) {
          for (const tc of msg.tool_calls) {
            if (turn.signal && turn.signal.aborted) throw new DOMException("stopped", "AbortError");
            onStep(tc.function.name.replace(/_/g, " "));
            let args = {};
            try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
            catch (e) { args = {}; }
            let result;
            try { result = await executeTool(tc.function.name, args, turn); }
            catch (e) { result = { error: e && e.message ? e.message : String(e) }; }
            // query_elements answers in TOON (already a string); everything else in JSON
            agent.messages.push({ role: "tool", tool_call_id: tc.id, content: typeof result === "string" ? result : JSON.stringify(result) });
          }
          while (turn.images.length) {
            agent.messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: turn.images.shift(), detail: "high" } }, { type: "text", text: "(canvas capture)" }] });
          }
          continue;
        }
        return { reply: msg.content || "", changed: true };
      }
      return { reply: "I stopped after 20 tool steps, so the canvas is partly changed. Say \"continue\" to finish.", changed: true };
    } finally {
      agent.messages = dropIncompleteTurn(agent.messages);
      saveMessages();
    }
  }

  function agentReset() {
    agent.messages = [];
    agent.snapshot = null;
    saveMessages();
  }

  // put the scene back to how it was before the last turn (one undo step)
  function agentRevert() {
    if (!agent.snapshot) return false;
    excalidrawAPI.updateScene({ elements: agent.snapshot, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    agent.snapshot = null;
    return true;
  }

  async function agentModels() {
    const res = await fetch(modelsEndpoint, { headers: headers });
    if (!res.ok) throw new Error("could not load models (" + res.status + ")");
    return res.json(); // { models: [{ id, vision, maxTokens }], default }
  }

  // BYOK: the key never round-trips to the browser, so status reports only
  // whether one is loaded plus a masked hint.
  async function agentStatus() {
    const res = await fetch(statusEndpoint, { headers: headers });
    if (!res.ok) throw new Error("could not load settings (" + res.status + ")");
    return res.json(); // { configured, provider, keyHint, providers: [{ id, label, keysUrl }] }
  }

  // try a key + endpoint without saving; resolves with what the provider serves
  async function agentTest(opts) {
    const res = await fetch(testEndpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ provider: opts.provider || "", baseUrl: opts.baseUrl || "", apiKey: opts.apiKey || "" }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "test failed (" + res.status + ")");
    return data; // { ok, baseUrl, models: [{ id, vision, reasoning, maxTokens }], found }
  }

  async function agentSetup(opts) {
    const res = await fetch(configEndpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ provider: opts.provider || "", apiKey: opts.apiKey || "", baseUrl: opts.baseUrl || "", models: opts.models || undefined }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "could not save settings (" + res.status + ")");
    return data; // same shape as status, plus the new model list
  }

  async function chatsFetch(path, opts) {
    const res = await fetch(chatsEndpoint + path, Object.assign({ headers: headers }, opts));
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("chat store failed (" + res.status + ")"));
    return data;
  }

  function configure(opts) {
    if (opts && typeof opts.visionModel === "string") prefs.visionModel = opts.visionModel;
  }

  return {
    configure: configure,
    // run a canvas tool directly, no model in the loop (tests, dev console)
    tool: function (name, args) { return executeTool(name, args || {}, { vision: false, images: [] }); },
    refine: refine,
    generateFromText: generateFromText,
    accept: accept,
    reject: reject,
    agent: { send: agentSend, reset: agentReset, revert: agentRevert, load: agentLoad, models: agentModels, status: agentStatus, setup: agentSetup, test: agentTest },
    chats: {
      list: function () { return chatsFetch("", {}).then(function (r) { return r.chats; }); },
      create: function (title) { return chatsFetch("", { method: "POST", body: JSON.stringify({ title: title }) }).then(function (r) { return r.meta; }); },
      read: function (id) { return chatsFetch("/" + id, {}); },
      save: function (id, patch) { return chatsFetch("/" + id, { method: "PUT", body: JSON.stringify(patch) }); },
      remove: function (id) { return chatsFetch("/" + id, { method: "DELETE" }); },
    },
  };
}
