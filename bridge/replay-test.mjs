// Replay the reported chat's ACTUAL transcript against the CURRENT system
// prompt: 30+ messages in which the model already wired the complete graph
// three times and confirmed it. Far stronger contamination than a synthetic
// four-message prefix. Usage: node replay-test.mjs <chat-id>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callChat } from "./vision.mjs";
import { systemPromptFor, AGENT_TOOLS } from "./agent-contract.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

const dir = join(process.env.AI_DATA_DIR || join(homedir(), ".excalidraw-ai"), "chats", process.argv[2]);
const prior = JSON.parse(readFileSync(join(dir, "chat.json"), "utf8")).messages;
const scene = JSON.parse(readFileSync(join(dir, "scene.json"), "utf8")).elements.filter(function (e) { return e.type === "freedraw"; });

// everything before the last user turn, then re-ask it
const last = prior.map(function (m) { return m.role; }).lastIndexOf("user");
const messages = [{ role: "system", content: systemPromptFor("assistant") }].concat(prior.slice(0, last + 1));

const box = new Map(scene.map(function (e) { return [e.id, { id: e.id, x: e.x, y: e.y, w: e.width, h: e.height }]; }));
const edges = [];
const lines = [];
function runTool(name, args) {
  if (name === "query_elements") {
    const rows = Array.from(box.values())
      .map(function (b) { return [b.id, "freedraw", Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), "", "", ""].join(","); })
      .concat(lines.map(function (l) { return [l.id, l.type, 0, 0, 0, 0, "", l.from, l.to].join(","); }));
    return "elements[" + rows.length + "]{id,type,x,y,w,h,text,from,to}:\n" + rows.join("\n");
  }
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
    (args.changes || []).forEach(function (c) { const b = box.get(c.id); if (b) { if (typeof c.x === "number") b.x = c.x; if (typeof c.y === "number") b.y = c.y; } });
    return JSON.stringify({ ok: true });
  }
  if (name === "create_elements") {
    (args.elements || []).forEach(function (e) { if (e.type === "arrow" || e.type === "line") { const id = "e" + edges.length; edges.push([e.start, e.end]); lines.push({ id: id, type: e.type, from: e.start, to: e.end }); } });
    return JSON.stringify({ created: (args.elements || []).map(function (e, i) { return { id: "e" + i, type: e.type }; }) });
  }
  if (name === "capture") return JSON.stringify({ description: "Hand-drawn circles connected by straight lines." });
  return JSON.stringify({ ok: true });
}

const config = { baseUrl: process.env.AI_API_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_AGENT_MODEL || process.env.AI_API_MODEL };
for (let t = 0; t < 8; t++) {
  const m = await callChat({ messages: messages, tools: AGENT_TOOLS, config, model: config.model, maxTokens: 32000 });
  messages.push(m);
  if (!m.tool_calls || !m.tool_calls.length) { console.log("REPLY:", (m.content || "").slice(0, 300)); break; }
  for (const tc of m.tool_calls) {
    let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
    console.log("TOOL:", tc.function.name, JSON.stringify(a).slice(0, 140));
    messages.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc.function.name, a) });
  }
}

const pts = Array.from(box.values()).map(function (b) { return { id: b.id, cx: b.x + b.w / 2 }; }).sort(function (a, b) { return a.cx - b.cx; });
const layer = new Map(); let l = 0;
pts.forEach(function (p, i) { if (i && p.cx - pts[i - 1].cx > 60) l++; layer.set(p.id, l); });
const bad = edges.filter(function (e) { const a = layer.get(e[0]), b = layer.get(e[1]); return a === undefined || b === undefined || Math.abs(b - a) !== 1; });
console.log("\nedges:", edges.length, "layers:", l + 1, "non-adjacent:", bad.length);
console.log(edges.length && edges.length < 45 && l + 1 >= 3 && !bad.length ? "PASS" : "FAIL");
