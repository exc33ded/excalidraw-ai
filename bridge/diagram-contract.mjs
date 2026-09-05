// Penecho -> Excalidraw bridge: the diagram output contract.
// Mirrors Penecho's vision -> structured-JSON discipline (src/server/main.js
// SYSTEM_PROMPT), but emits Excalidraw element skeletons instead of Penecho's
// raster draw / write_text / plot_function commands.

export const ALLOWED_TYPES = new Set([
  "rectangle", "ellipse", "diamond", "text", "arrow", "line",
]);

export const MAX_ELEMENTS = 64;
export const MAX_LABEL_CHARS = 500;

// Coordinates are RELATIVE fractions of the input image (0..1), so the client
// can map them onto any target region regardless of the export scale. x,y is
// the top-left corner.
export const DIAGRAM_SYSTEM_PROMPT = [
  "You are the visual reasoning brain for an Excalidraw whiteboard.",
  "You receive ONE image: a rendering of the region to work on. Elements to CLEAN UP are outlined in a thick blue stroke; surrounding context elements are dimmed (low opacity).",
  "Regenerate ALL visible elements as one clean, editable diagram: every node, every connection, every label.",
  "Preserve every dimmed context element's label and its connections; you may nudge its position slightly to fit.",
  "If nothing is highlighted or dimmed, treat the whole image as the target.",
  "Produce a single clean, editable Excalidraw diagram that faithfully captures every node, every connection, and every label.",
  "",
  "Understand the drawing:",
  "- Transcribe every box, diamond and ellipse, and every label. Infer node text from handwriting.",
  "- Recover the graph structure: which node connects to which, and the direction.",
  "- Preserve spatial meaning: left-to-right order, clusters/groups, and relative position.",
  "",
  "Output rules:",
  "- Return exactly ONE compact JSON object. No prose, no markdown fences, no commentary.",
  '- The object has one key: "elements", an array of element skeletons.',
  "- Coordinates are RELATIVE fractions of the image: x and y are the top-left in [0,1]; width and height are in [0,1]. Never emit pixel or canvas coordinates.",
  "- Allowed element types: rectangle, ellipse, diamond, text, arrow, line.",
  "- A node is a rectangle/ellipse/diamond with a label.text.",
  "- A connection is an arrow with points [[x1,y1],[x2,y2]] as relative fractions, plus an optional label.text for edge labels.",
  "- To bind an arrow to its nodes, give each node an id and reference those ids from the arrow's start and end objects.",
  "- Standalone text uses type text.",
  "- Keep all numbers finite and inside [0,1]. Lay nodes out without heavy overlap.",
  "- If you cannot read a label confidently, still emit the node with your best guess in label.text. NEVER drop a node.",
  "",
  "Example nodes:",
  '{"type":"rectangle","id":"n1","x":0.10,"y":0.20,"width":0.18,"height":0.08,"label":{"text":"Start"}}',
  '{"type":"diamond","id":"n2","x":0.45,"y":0.20,"width":0.16,"height":0.12,"label":{"text":"Done?"}}',
  "",
  "Example bound connection:",
  '{"type":"arrow","x":0.28,"y":0.24,"points":[[0,0],[0.17,0]],"start":{"id":"n1"},"end":{"id":"n2"},"label":{"text":"yes"}}',
  "",
  "Return only the JSON object."
].join("\n");

// Text -> diagram generation: no image, invent the whole diagram from the
// description. Reuses the same relative [0..1] element schema + validateSkeleton.
export const DIAGRAM_GENERATION_PROMPT = [
  "You are the diagram-generation brain for an Excalidraw whiteboard.",
  "You receive a short natural-language description of a diagram the user wants. No image is provided; invent the whole diagram.",
  "Produce a single clean, editable Excalidraw diagram that faithfully realizes the description.",
  "",
  "Plan the diagram:",
  "- Infer the type: flowchart, neural network, mind map, architecture, relationship/entity, data flow, sequence, or class diagram.",
  "- Choose nodes: rectangle for steps/components/entities, ellipse for start/end/emphasis, diamond for decisions, text for annotations.",
  "- Decide the graph structure: which node connects to which, and the direction.",
  "- Lay out nodes in a clear grid, layered left-to-right, or radial (mind map) arrangement. Spread across the full canvas; no overlaps.",
  "- For neural networks and layered systems, arrange one column per layer and connect nodes in each column to nodes in the next.",
  "",
  "Output rules:",
  "- Return exactly ONE compact JSON object. No prose, no markdown fences, no commentary.",
  '- The object has one key: "elements", an array of element skeletons.',
  "- Coordinates are RELATIVE fractions of a virtual square canvas: x and y are the top-left in [0,1]; width and height are in [0,1]. Never emit pixel coordinates.",
  "- Allowed element types: rectangle, ellipse, diamond, text, arrow, line.",
  "- Every node (rectangle/ellipse/diamond) has a short label.text.",
  "- A connection is an arrow. Give each node an id and bind the arrow with start and end referencing those ids; also include points as a fallback visual path.",
  "- Keep every number finite and inside [0,1]. Keep labels short.",
  "- Prefer 4 to 14 nodes for clarity unless the description clearly needs more.",
  "",
  "Example nodes:",
  '{"type":"rectangle","id":"n1","x":0.10,"y":0.20,"width":0.16,"height":0.08,"label":{"text":"Input layer"}}',
  '{"type":"ellipse","id":"n2","x":0.60,"y":0.20,"width":0.14,"height":0.10,"label":{"text":"Output"}}',
  "",
  "Example bound connection:",
  '{"type":"arrow","x":0.26,"y":0.24,"points":[[0,0],[0.30,0]],"start":{"id":"n1"},"end":{"id":"n2"}}',
  "",
  "Return only the JSON object."
].join("\n");

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Validate + sanitize model output. Returns { ok:true, elements } or
// { ok:false, error }. Mirrors Penecho's strict local validation pass.
export function validateSkeleton(elements) {
  if (!Array.isArray(elements) || elements.length === 0) {
    return { ok: false, error: "elements must be a non-empty array" };
  }
  if (elements.length > MAX_ELEMENTS) {
    return { ok: false, error: "too many elements (max " + MAX_ELEMENTS + ")" };
  }
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, error: "element[" + i + "] is not an object" };
    }
    if (!ALLOWED_TYPES.has(e.type)) {
      return { ok: false, error: "element[" + i + "] has unsupported type " + JSON.stringify(e.type) };
    }
    if (!isNum(e.x) || !isNum(e.y)) {
      return { ok: false, error: "element[" + i + "] needs finite x,y" };
    }
    const t = e.type;
    // text is NOT in this list: Excalidraw sizes a text element from its content,
    // so w/h are optional there. Requiring them threw away a whole valid diagram
    // whenever the model emitted one bare annotation.
    const needsSize = t === "rectangle" || t === "ellipse" || t === "diamond";
    if (needsSize && (!isNum(e.width) || !isNum(e.height))) {
      return { ok: false, error: "element[" + i + "] (" + t + ") needs width,height" };
    }
    if ((t === "arrow" || t === "line") && !Array.isArray(e.points) && !(e.start && e.end)) {
      return { ok: false, error: "element[" + i + "] (" + t + ") needs points or start/end bindings" };
    }
    const c = { type: t, x: e.x, y: e.y };
    if (isNum(e.width)) c.width = e.width;
    if (isNum(e.height)) c.height = e.height;
    if (isNum(e.strokeWidth)) c.strokeWidth = e.strokeWidth;
    if (typeof e.strokeColor === "string") c.strokeColor = e.strokeColor;
    if (typeof e.backgroundColor === "string") c.backgroundColor = e.backgroundColor;
    if (typeof e.id === "string" && e.id && e.id.length <= 64) c.id = e.id;
    if (e.start && typeof e.start === "object" && !Array.isArray(e.start)) {
      const s = {};
      if (typeof e.start.id === "string" && e.start.id.length <= 64) s.id = e.start.id;
      if (typeof e.start.type === "string" && ALLOWED_TYPES.has(e.start.type)) s.type = e.start.type;
      if (s.id || s.type) c.start = s;
    }
    if (e.end && typeof e.end === "object" && !Array.isArray(e.end)) {
      const en = {};
      if (typeof e.end.id === "string" && e.end.id.length <= 64) en.id = e.end.id;
      if (typeof e.end.type === "string" && ALLOWED_TYPES.has(e.end.type)) en.type = e.end.type;
      if (en.id || en.type) c.end = en;
    }
    if (Array.isArray(e.points)) {
      c.points = e.points.map(function (p) {
        return Array.isArray(p) && isNum(p[0]) && isNum(p[1]) ? [p[0], p[1]] : null;
      }).filter(Boolean);
    }
    if (e.label && typeof e.label === "object" && typeof e.label.text === "string") {
      c.label = { text: e.label.text.slice(0, MAX_LABEL_CHARS) };
      if (isNum(e.label.fontSize)) c.label.fontSize = e.label.fontSize;
    }
    if (t === "text") {
      c.text = typeof e.text === "string" ? e.text.slice(0, MAX_LABEL_CHARS) : "";
    }
    out.push(c);
  }
  return { ok: true, elements: out };
}

// Canvas self-verification: the agent brain (deepseek-v4-flash) has no vision,
// so its `capture` tool sends the screenshot here and gets words back. JSON
// because vision.mjs hard-codes response_format json_object.
export const DESCRIBE_SYSTEM_PROMPT = [
  "You are the eyes of an agent editing an Excalidraw whiteboard.",
  "You receive ONE image: a rendering of the canvas (or part of it) that the agent just changed.",
  "Describe what is actually visible so the agent can verify its own work.",
  "",
  "Report, in this order and only what you can see:",
  "- The overall layout: how many nodes, how they are arranged (rows, columns, layers, radial), and the reading direction.",
  "- Every visible label, transcribed exactly.",
  "- Problems: overlapping shapes, text spilling outside its shape, crossing or dangling arrows, crowding, ragged alignment, elements running off the edge.",
  "- If the user asked a specific question, answer it directly first.",
  "",
  "Be concrete and spatial (\"the two right-hand boxes overlap by about half their width\").",
  "Do not invent anything you cannot see, and do not guess at coordinates.",
  "",
  'Return exactly ONE JSON object: {"description":"..."}. No prose, no markdown fences.',
].join("\n");
