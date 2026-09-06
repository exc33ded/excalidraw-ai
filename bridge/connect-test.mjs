// Live regression for the hairball: 10 scattered hand-drawn blobs + "connect
// them feed-forward" used to come back as all 45 pairs. Runs the real agent
// prompt and tools against a fake canvas and checks the wiring, not the pixels.
// Reads bridge/.env.
import { callChat } from "./vision.mjs";
import { systemPromptFor, AGENT_TOOLS } from "./agent-contract.mjs";
import { QUERY_COLUMNS } from "./geometry.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

// the actual scene from the reported chat, ids shortened
const NODES = [
  ["Fl7N", 216, 238, 58, 64], ["7AY1", 227, 296, 50, 64], ["we1_", 245, 365, 41, 73],
  ["wD6w", 252, 455, 39, 41], ["9TcV", 159, 290, 53, 53], ["1GfR", 185, 362, 45, 57],
  ["Pvmw", 92, 333, 36, 48], ["P1on", 337, 293, 48, 50], ["q5Eo", 341, 371, 64, 38],
  ["PNXw", 408, 318, 51, 50],
].map(function (n) { return { id: n[0], type: "freedraw", x: n[1], y: n[2], w: n[3], h: n[4] }; });

const box = new Map(NODES.map(function (n) { return [n.id, Object.assign({}, n)]; }));
const edges = [];
const lines = [];

function toon(rows) {
  return "elements[" + rows.length + "]{" + QUERY_COLUMNS.join(",") + "}:\n" +
    rows.map(function (r) { return QUERY_COLUMNS.map(function (c) { return r[c] === undefined ? "" : r[c]; }).join(","); }).join("\n");
}

function runTool(name, args) {
  if (name === "query_elements") return toon(Array.from(box.values()).concat(lines));
if (name === "connect_layers") {
    const layers = (args.layers || []).filter(function (l) { return Array.isArray(l) && l.length; });
    if (layers.length < 2) return JSON.stringify({ error: "layers needs at least two groups" });
    const ids = layers.flat();
    const missing = ids.filter(function (id) { return !box.has(id); });
    if (missing.length) return JSON.stringify({ error: "no such elements: " + missing.join(", ") });
    const nodes = ids.map(function (id) { return box.get(id); });
    const minX = Math.min.apply(null, nodes.map(function (n) { return n.x; }));
    const minY = Math.min.apply(null, nodes.map(function (n) { return n.y; }));
    const maxY = Math.max.apply(null, nodes.map(function (n) { return n.y + n.h; }));
    const wide = Math.max.apply(null, nodes.map(function (n) { return n.w; }));
    const tall = Math.max.apply(null, nodes.map(function (n) { return n.h; }));
    const colGap = wide * 2.5, rowGap = tall * 1.6, cy = (minY + maxY) / 2;
    layers.forEach(function (layer, i) {
      const x = minX + i * colGap;
      const top = cy - ((layer.length - 1) * rowGap) / 2;
      layer.forEach(function (id, j) {
        const n = box.get(id);
        n.x = Math.round(x + (wide - n.w) / 2);
        n.y = Math.round(top + j * rowGap - n.h / 2);
      });
    });
    for (let i = 0; i + 1 < layers.length; i++) {
      layers[i].forEach(function (from) {
        layers[i + 1].forEach(function (to) {
          const id = "e" + edges.length;
          edges.push([from, to]);
          lines.push({ id: id, type: args.arrowheads === false ? "line" : "arrow", from: from, to: to });
        });
      });
    }
    return JSON.stringify({ arranged: ids.length, connected: edges.length, layers: layers.map(function (l) { return l.length; }) });
  }
  if (name === "update_elements") {
    (args.changes || []).forEach(function (c) {
      const b = box.get(c.id);
      if (!b) return;
      if (typeof c.x === "number") b.x = c.x;
      if (typeof c.y === "number") b.y = c.y;
    });
    return JSON.stringify({ ok: true });
  }
  if (name === "create_elements") {
    (args.elements || []).forEach(function (e) {
      if (e.type === "arrow" || e.type === "line") { const id = "e" + edges.length; edges.push([e.start, e.end]); lines.push({ id: id, type: e.type, from: e.start, to: e.end }); }
      else box.set(e.id || "new" + box.size, { id: e.id, type: e.type, x: e.x, y: e.y, w: e.width || 0, h: e.height || 0 });
    });
    return JSON.stringify({ ok: true, ids: (args.elements || []).map(function (e, i) { return e.id || "e" + i; }) });
  }
  if (name === "capture") return "A left-to-right arrangement of hand-drawn circles.";
  return JSON.stringify({ ok: true });
}

// layer index of each node by x-center, splitting wherever the gap exceeds 60px
function layers() {
  const pts = Array.from(box.values())
    .filter(function (b) { return b.type === "freedraw"; })
    .map(function (b) { return { id: b.id, cx: b.x + b.w / 2 }; })
    .sort(function (a, b) { return a.cx - b.cx; });
  const of = new Map();
  let l = 0;
  pts.forEach(function (p, i) {
    if (i && p.cx - pts[i - 1].cx > 60) l++;
    of.set(p.id, l);
  });
  return { of: of, count: l + 1 };
}

const config = { baseUrl: process.env.AI_API_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_AGENT_MODEL || process.env.AI_API_MODEL };
const messages = [
  { role: "system", content: systemPromptFor("assistant") },
];

// --contaminated: the shape of the reported chat, where the model had already
// talked itself into the wrong definition in an earlier turn. A system rule
// that only wins on an empty transcript does not fix the reported bug.
if (process.argv.includes("--contaminated")) {
  messages.push(
    { role: "user", content: "This is a Neural Network diagram connect each node properly with each other" },
    { role: "assistant", content: "These 10 hand-drawn blobs are scattered with no clear rows or columns. Do you want them (1) fully connected, or (2) feed-forward by position - each node connects to every node roughly to its right?" },
    { role: "user", content: "feed-forward and no pointing arrows" },
    { role: "assistant", content: "I will connect the nodes feed-forward: every node gets a plain line to every node to its right, ordered by horizontal position." },
  );
}
messages.push(
  { role: "user", content: "This is a Neural Network diagram, connect each node properly: feed-forward, plain lines, no arrowheads. (10 elements are selected: " + NODES.map(function (n) { return n.id; }).join(", ") + ")" },
);

for (let turn = 0; turn < 8; turn++) {
  const m = await callChat({ messages: messages, tools: AGENT_TOOLS, config, model: config.model, maxTokens: 32000 });
  messages.push(m);
  if (!m.tool_calls || !m.tool_calls.length) { console.log("REPLY:", (m.content || "").slice(0, 400)); break; }
  for (const tc of m.tool_calls) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
    console.log("TOOL:", tc.function.name, JSON.stringify(args).slice(0, 200));
    messages.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc.function.name, args) });
  }
}

const L = layers();
const bad = edges.filter(function (e) {
  const a = L.of.get(e[0]), b = L.of.get(e[1]);
  return a === undefined || b === undefined || Math.abs(b - a) !== 1;
});
console.log("\nedges:", edges.length, "layers:", L.count, "non-adjacent:", bad.length);
const ok = edges.length > 0 && edges.length < 45 && L.count >= 3 && bad.length === 0;
console.log(ok ? "PASS" : "FAIL", "- feed-forward means adjacent layers only");
process.exitCode = ok ? 0 : 1;
