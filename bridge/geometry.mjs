// Pure canvas helpers. No @excalidraw import, so test.mjs can cover them
// without a browser.

export function bboxOf(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of elements) {
    // one element with a null/NaN coordinate must not poison the whole box,
    // or every "place beside existing content" falls back to the origin
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const x2 = e.x + (e.width || 0);
    const y2 = e.y + (e.height || 0);
    minX = Math.min(minX, e.x); minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// map relative [0..1] coordinates onto an absolute target rect
export function mapToAbsolute(skeleton, target) {
  return skeleton.map(function (s) {
    const out = Object.assign({}, s);
    out.x = target.x + (s.x || 0) * target.width;
    out.y = target.y + (s.y || 0) * target.height;
    if (typeof s.width === "number") out.width = s.width * target.width;
    if (typeof s.height === "number") out.height = s.height * target.height;
    if (Array.isArray(s.points)) {
      out.points = s.points.map(function (p) { return [p[0] * target.width, p[1] * target.height]; });
    }
    return out;
  });
}

// give every element a unique id (keeping the model's own ids) and rewrite
// arrow start/end references to match
export function normalizeIds(skeleton) {
  const prefix = "ai" + Math.random().toString(36).slice(2, 8);
  const idOf = new Map();
  return skeleton
    .map(function (s, i) {
      const id = typeof s.id === "string" && s.id ? s.id : prefix + i;
      idOf.set(s.id, id);
      return Object.assign({}, s, { id: id });
    })
    .map(function (s) {
      const out = Object.assign({}, s);
      if (out.start && out.start.id) out.start = Object.assign({}, out.start, { id: idOf.get(out.start.id) || out.start.id });
      if (out.end && out.end.id) out.end = Object.assign({}, out.end, { id: idOf.get(out.end.id) || out.end.id });
      return out;
    });
}

// a scene (or selection) that is only text is a description, not a sketch
export function textDescriptionOf(elements) {
  const shapes = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "freedraw", "image", "frame"]);
  if (elements.some(function (e) { return shapes.has(e.type); })) return null;
  const lines = elements
    .filter(function (e) { return e.type === "text" && e.text && e.text.trim(); })
    .map(function (e) { return e.text.trim(); });
  return lines.length ? lines.join("\n") : null;
}

// selection + 1-hop structural context: bound arrows and their far ends,
// whole groups, containing frames
export function expandSelection(selected, all) {
  const byId = new Map(all.map(function (e) { return [e.id, e]; }));
  const ids = new Set(selected.map(function (e) { return e.id; }));
  const groups = new Map();
  for (const e of all) {
    if (e.groupIds && e.groupIds.length) {
      for (const g of e.groupIds) {
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e.id);
      }
    }
  }
  const arrowsOf = new Map();
  for (const e of all) {
    const s = e.startBinding && e.startBinding.elementId;
    const t = e.endBinding && e.endBinding.elementId;
    if (s) { if (!arrowsOf.has(s)) arrowsOf.set(s, []); arrowsOf.get(s).push(e); }
    if (t && t !== s) { if (!arrowsOf.has(t)) arrowsOf.set(t, []); arrowsOf.get(t).push(e); }
  }
  const seed = Array.from(ids);
  for (const id of seed) {
    const e = byId.get(id);
    if (!e) continue;
    for (const a of arrowsOf.get(id) || []) {
      ids.add(a.id);
      const s = a.startBinding && a.startBinding.elementId;
      const t = a.endBinding && a.endBinding.elementId;
      if (s && s !== id) ids.add(s);
      if (t && t !== id) ids.add(t);
    }
    if (e.groupIds) {
      for (const g of e.groupIds) for (const m of groups.get(g) || []) ids.add(m);
    }
    if (e.frameId) ids.add(e.frameId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Labels. Excalidraw keeps a shape's label in a SEPARATE text element with
// containerId; the shape itself has no .label. Everything below reads and
// writes labels through the container.
// ---------------------------------------------------------------------------

export function labelIndex(elements) {
  const idx = new Map(); // container id -> bound text element
  for (const e of elements) {
    if (e.type === "text" && e.containerId) idx.set(e.containerId, e);
  }
  return idx;
}

export function isBoundLabel(e) {
  return e.type === "text" && !!e.containerId;
}

export function textOf(e, labels) {
  if (e.type === "text") return e.text || "";
  const label = labels.get(e.id);
  return (label && label.text) || "";
}

export function summarizeElement(e, labels) {
  const out = { id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width || 0), h: Math.round(e.height || 0) };
  const text = textOf(e, labels);
  if (text) out.text = text;
  if (e.startBinding && e.startBinding.elementId) out.from = e.startBinding.elementId;
  if (e.endBinding && e.endBinding.elementId) out.to = e.endBinding.elementId;
  return out;
}

// where a bound label sits after its container moved or resized
// ponytail: keeps the label's own width/height, so a much longer text keeps
// the old box width; re-wrap needs wrapText, which the package does not export
export function centeredLabelPosition(label, container) {
  if (container.type === "arrow" || container.type === "line") return null;
  return {
    x: container.x + ((container.width || 0) - (label.width || 0)) / 2,
    y: container.y + ((container.height || 0) - (label.height || 0)) / 2,
  };
}

// TOON only collapses a UNIFORM array into its tabular form, so every row
// carries every column, empty when the field does not apply.
export const QUERY_COLUMNS = ["id", "type", "x", "y", "w", "h", "text", "from", "to"];

export function toQueryRows(elements, labels) {
  return elements.map(function (e) {
    const s = summarizeElement(e, labels);
    const row = {};
    for (const c of QUERY_COLUMNS) row[c] = s[c] === undefined ? "" : s[c];
    return row;
  });
}

// Geometry for an arrow from box a to box b: edge midpoint to edge midpoint on
// the dominant axis. convertToExcalidrawElements binds an arrow to its start/end
// but never positions it, so an arrow given only ids would have no x/y at all.
export function arrowBetween(a, b) {
  const ac = { x: a.x + (a.width || 0) / 2, y: a.y + (a.height || 0) / 2 };
  const bc = { x: b.x + (b.width || 0) / 2, y: b.y + (b.height || 0) / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  let from, to;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = dx >= 0 ? 1 : -1;
    from = { x: ac.x + s * (a.width || 0) / 2, y: ac.y };
    to = { x: bc.x - s * (b.width || 0) / 2, y: bc.y };
  } else {
    const s = dy >= 0 ? 1 : -1;
    from = { x: ac.x, y: ac.y + s * (a.height || 0) / 2 };
    to = { x: bc.x, y: bc.y - s * (b.height || 0) / 2 };
  }
  return { x: from.x, y: from.y, points: [[0, 0], [to.x - from.x, to.y - from.y]] };
}

// Rewrite every arrow that connects two known boxes to run edge to edge.
// `existing` are scene elements the arrows may reference; `specs` are the new
// skeletons (boxes among them count too). Used by every path that creates
// arrows from model output: the model's own points are usually missing or
// end inside the node.
export function positionBoundArrows(specs, existing) {
  const boxes = new Map((existing || []).map(function (e) { return [e.id, e]; }));
  specs.forEach(function (s) { if (typeof s.x === "number" && typeof s.y === "number") boxes.set(s.id, s); });
  return specs.map(function (s) {
    if (s.type !== "arrow" && s.type !== "line") return s;
    const a = s.start && boxes.get(s.start.id), b = s.end && boxes.get(s.end.id);
    return a && b ? Object.assign({}, s, arrowBetween(a, b)) : s;
  });
}

// The model sometimes draws an arrow with raw points that land inside two
// boxes instead of naming them. Recover the bindings from geometry: an
// endpoint inside exactly one box means that box. Only fills in what is
// missing; explicit start/end win.
export function snapArrowEndpoints(specs, existing) {
  const boxes = (existing || []).concat(specs).filter(function (e) {
    return (e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond") && typeof e.x === "number" && typeof e.y === "number";
  });
  const hit = function (px, py) {
    const inside = boxes.filter(function (b) { return px >= b.x && px <= b.x + (b.width || 0) && py >= b.y && py <= b.y + (b.height || 0); });
    return inside.length === 1 ? inside[0] : null;
  };
  return specs.map(function (s) {
    if (s.type !== "arrow" || !Array.isArray(s.points) || s.points.length < 2 || typeof s.x !== "number") return s;
    const out = Object.assign({}, s);
    const first = s.points[0], last = s.points[s.points.length - 1];
    if (!out.start) { const b = hit(s.x + first[0], s.y + first[1]); if (b) out.start = { id: b.id }; }
    if (!out.end) { const b = hit(s.x + last[0], s.y + last[1]); if (b) out.end = { id: b.id }; }
    return out;
  });
}
