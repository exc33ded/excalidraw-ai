// Offline tests (no API key, no browser): the contract + request builder.
import { validateSkeleton, DIAGRAM_SYSTEM_PROMPT } from "./diagram-contract.mjs";
import { buildVisionRequest } from "./vision.mjs";
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, AGENT_MODES, systemPromptFor, parseModelList, trimMessages, dropIncompleteTurn, PROVIDER_PRESETS, maskKey, mergeDiscoveredModels, DISCOVERED_MAX_TOKENS, REASONING_MAX_TOKENS } from "./agent-contract.mjs";
import { bboxOf, expandSelection, textDescriptionOf, labelIndex, isBoundLabel, textOf, summarizeElement, centeredLabelPosition, toQueryRows, QUERY_COLUMNS, arrowBetween, positionBoundArrows, snapArrowEndpoints } from "./geometry.mjs";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FAIL " + name); }
}

const good = validateSkeleton([
  { type: "rectangle", x: 0.1, y: 0.2, width: 0.2, height: 0.1, label: { text: "Start" } },
  { type: "arrow", x: 0.3, y: 0.25, points: [[0, 0], [0.1, 0]], label: { text: "yes" } },
]);
check("valid skeleton accepted", good.ok === true);
check("sanitized keeps label", good.ok && good.elements[0].label.text === "Start");

check("bad type rejected", validateSkeleton([{ type: "hexagon", x: 0, y: 0, width: 1, height: 1 }]).ok === false);
check("arrow without points rejected", validateSkeleton([{ type: "arrow", x: 0, y: 0 }]).ok === false);
check("text without size accepted (excalidraw auto-sizes it)", validateSkeleton([{ type: "text", x: 0.1, y: 0.2, text: "note" }]).ok === true);
check("shape without size still rejected", validateSkeleton([{ type: "rectangle", x: 0.1, y: 0.2 }]).ok === false);
check("non-finite coord rejected", validateSkeleton([{ type: "text", x: "x", y: 0, width: 1, height: 1 }]).ok === false);
check("empty rejected", validateSkeleton([]).ok === false);

const many = Array.from({ length: 65 }, function () { return { type: "text", x: 0, y: 0, width: 1, height: 1 }; });
check("too many rejected", validateSkeleton(many).ok === false);

const req = buildVisionRequest({ image: "data:image/png;base64,AAAA", prompt: "", model: "gpt-4o" });
check("request has system prompt", req.messages[0].role === "system" && req.messages[0].content.length > 0);
check("request has image content", Array.isArray(req.messages[1].content) && req.messages[1].content.some(function (c) { return c.type === "image_url"; }));
const textReq = buildVisionRequest({ prompt: "neural net", model: "gpt-4o" });
check("text-only request has no image", Array.isArray(textReq.messages[1].content) && !textReq.messages[1].content.some(function (c) { return c.type === "image_url"; }));
check("request is json_object", req.response_format && req.response_format.type === "json_object");

check("prompt mentions elements", DIAGRAM_SYSTEM_PROMPT.indexOf('"elements"') !== -1);
check("prompt mentions relative fractions", DIAGRAM_SYSTEM_PROMPT.indexOf("RELATIVE") !== -1);

check("bound arrow accepted", validateSkeleton([{ type: "arrow", x: 0.3, y: 0.2, start: { id: "n1" }, end: { id: "n2" } }]).ok === true);
check("arrow with neither points nor bindings rejected", validateSkeleton([{ type: "arrow", x: 0.3, y: 0.2 }]).ok === false);
const bound = validateSkeleton([
  { type: "rectangle", id: "n1", x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
  { type: "arrow", x: 0.3, y: 0.15, start: { id: "n1" }, end: { id: "n2" } },
]);
check("id and start/end survive sanitization", bound.ok && bound.elements[1].start.id === "n1");

const scene = [
  { id: "s1", type: "rectangle", x: 0, y: 0, width: 100, height: 50, groupIds: [], frameId: null },
  { id: "s2", type: "diamond", x: 200, y: 0, width: 100, height: 50, groupIds: [], frameId: null },
  { id: "a1", type: "arrow", x: 100, y: 25, points: [[0, 0], [100, 0]], startBinding: { elementId: "s1" }, endBinding: { elementId: "s2" }, groupIds: [] },
  { id: "g1", type: "rectangle", x: 0, y: 200, width: 50, height: 50, groupIds: ["grp"], frameId: null },
  { id: "g2", type: "rectangle", x: 100, y: 200, width: 50, height: 50, groupIds: ["grp"], frameId: null },
  { id: "far", type: "rectangle", x: 500, y: 500, width: 50, height: 50, groupIds: [], frameId: null },
];
const ws1 = expandSelection([scene[0]], scene);
check("selection expands to arrow + far end", ws1.has("s1") && ws1.has("a1") && ws1.has("s2") && !ws1.has("far"));
const ws2 = expandSelection([scene[3]], scene);
check("selection expands whole group", ws2.has("g1") && ws2.has("g2") && !ws2.has("far"));
check("text scene detected", textDescriptionOf([{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 20, text: "a neural network" }]) === "a neural network");
check("shape scene is not text", textDescriptionOf([{ id: "r", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }]) === null);


// Labels: Excalidraw keeps a shape's label in a SEPARATE bound text element,
// so the agent has to read and write it through the container.
const labelled = [
  { id: "box", type: "rectangle", x: 100, y: 100, width: 140, height: 80 },
  { id: "box-label", type: "text", x: 130, y: 130, width: 80, height: 20, text: "Start", containerId: "box" },
  { id: "loose", type: "text", x: 400, y: 400, width: 80, height: 20, text: "note" },
];
const idx = labelIndex(labelled);
check("label indexed by container", idx.get("box").id === "box-label");
check("bound label detected", isBoundLabel(labelled[1]) === true);
check("loose text is not a bound label", isBoundLabel(labelled[2]) === false);
check("shape reports its label as text", textOf(labelled[0], idx) === "Start");
check("summarize surfaces the label", summarizeElement(labelled[0], idx).text === "Start");
const moved = Object.assign({}, labelled[0], { x: 300 });
const pos = centeredLabelPosition(labelled[1], moved);
check("label re-centers on its moved container", pos.x === 330 && pos.y === 130);
check("arrow labels are left to excalidraw", centeredLabelPosition(labelled[1], { type: "arrow", x: 0, y: 0, width: 10, height: 10 }) === null);

// TOON's tabular form only applies to a uniform array, so every row must carry
// every column even when the field does not apply to that element type.
const qrows = toQueryRows(labelled.filter(function (e) { return !isBoundLabel(e); }), idx);
check("every query row has every column", qrows.every(function (r) {
  return QUERY_COLUMNS.every(function (c) { return Object.prototype.hasOwnProperty.call(r, c); });
}));
check("query rows share one key order", qrows.every(function (r) {
  return JSON.stringify(Object.keys(r)) === JSON.stringify(QUERY_COLUMNS);
}));
check("shape row carries its bound label as text", qrows[0].text === "Start");
check("missing fields are empty, not undefined", qrows[0].from === "" && qrows[0].to === "");
check("bound label is not its own row", qrows.length === 2);

// Agent contract: the model only reaches for a tool it is told about.
const toolNames = AGENT_TOOLS.map(function (t) { return t.function.name; });
check("every canvas tool is declared", ["query_elements", "create_elements", "update_elements", "delete_elements", "create_diagram", "set_view", "capture"]
  .every(function (n) { return toolNames.indexOf(n) !== -1; }));
check("every tool has a schema", AGENT_TOOLS.every(function (t) { return t.type === "function" && t.function.parameters && t.function.parameters.type === "object"; }));
check("create_diagram requires mermaid", AGENT_TOOLS.find(function (t) { return t.function.name === "create_diagram"; }).function.parameters.required[0] === "mermaid");
check("persona routes whole diagrams to mermaid", AGENT_SYSTEM_PROMPT.indexOf("create_diagram") !== -1 && AGENT_SYSTEM_PROMPT.indexOf("flowchart") !== -1);
check("persona explains that a shape's text is its label", AGENT_SYSTEM_PROMPT.indexOf("IS its label") !== -1);
check("persona explains the TOON table", AGENT_SYSTEM_PROMPT.indexOf("TOON") !== -1);
check("every mode builds on the shared canvas contract", Object.keys(AGENT_MODES).every(function (m) { return systemPromptFor(m).indexOf("TOON") !== -1 && systemPromptFor(m).indexOf(AGENT_MODES[m].prompt) !== -1; }));
check("assistant mode keeps replies short, guide does not", systemPromptFor("assistant").indexOf("1-2 sentences") !== -1 && systemPromptFor("guide").indexOf("1-2 sentences") === -1);
check("tutor mode confirms the roadmap and checks understanding", /roadmap/.test(AGENT_MODES.tutor.prompt) && /check question/.test(AGENT_MODES.tutor.prompt) && /re-explain/.test(AGENT_MODES.tutor.prompt));
check("unknown mode falls back to assistant", systemPromptFor("nope") === systemPromptFor("assistant"));

const poisoned = bboxOf([{ x: 10, y: 10, width: 20, height: 20 }, { x: null, y: null, width: 100, height: 0 }]);
check("bbox ignores an element with null coordinates", poisoned && poisoned.x === 10 && poisoned.width === 20);
check("bbox of only-broken elements is null", bboxOf([{ x: NaN, y: 0 }]) === null);

// Arrows between boxes: edge to edge on the dominant axis, never a null x/y.
const lr = arrowBetween({ x: 100, y: 100, width: 140, height: 70 }, { x: 300, y: 100, width: 140, height: 70 });
check("left-to-right arrow starts at the right edge", lr.x === 240 && lr.y === 135);
check("left-to-right arrow ends at the other box's left edge", lr.points[1][0] === 60 && lr.points[1][1] === 0);
const td = arrowBetween({ x: 0, y: 0, width: 100, height: 50 }, { x: 10, y: 200, width: 100, height: 50 });
check("top-down arrow leaves the bottom edge", td.y === 50 && td.points[1][1] === 150);
const rl = arrowBetween({ x: 300, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 });
check("right-to-left arrow points left", rl.x === 300 && rl.points[1][0] === -200);

const specs = [
  { id: "n1", type: "ellipse", x: 0, y: 0, width: 60, height: 40 },
  { id: "n2", type: "ellipse", x: 200, y: 0, width: 60, height: 40 },
  { type: "arrow", x: 30, y: 20, points: [[0, 0], [200, 0]], start: { id: "n1" }, end: { id: "n2" } },
  { type: "arrow", x: 30, y: 20, points: [[0, 0], [10, 0]], start: { id: "n1" }, end: { id: "old" } },
];
const fixed = positionBoundArrows(specs, [{ id: "old", type: "rectangle", x: 0, y: 200, width: 60, height: 40 }]);
check("arrow between new boxes is re-run edge to edge", fixed[2].x === 60 && fixed[2].points[1][0] === 140);
check("arrow to an existing scene box is positioned too", fixed[3].y === 40 && fixed[3].points[1][1] === 160);
check("boxes pass through untouched", fixed[0] === specs[0]);

const snapped = snapArrowEndpoints(
  [{ type: "arrow", x: 30, y: 20, points: [[0, 0], [190, 0]] }, { type: "arrow", x: 30, y: 20, points: [[0, 0], [10, 300]], end: { id: "keep" } }],
  [{ id: "a", type: "rectangle", x: 0, y: 0, width: 60, height: 40 }, { id: "b", type: "ellipse", x: 200, y: 0, width: 60, height: 40 }]);
check("loose arrow endpoints snap to the boxes they land in", snapped[0].start.id === "a" && snapped[0].end.id === "b");
check("explicit end is kept, missing start is filled", snapped[1].start.id === "a" && snapped[1].end.id === "keep");

// Model allowlist + conversation trimming (pure, so they live here not in the browser).
const models = parseModelList("deepseek-v4-flash, deepseek-v4-flash-vision-exp:vision:16000,,");
check("model list parses ids", models.length === 2 && models[0].id === "deepseek-v4-flash");
check("model list parses flags", models[1].vision === true && models[1].maxTokens === 16000 && models[0].maxTokens === 32000);
check("empty model list falls back", parseModelList("", "x")[0].id === "x");

const convo = [
  { role: "system", content: "sys" },
  { role: "user", content: "turn one".repeat(20) },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "query_elements", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "rows".repeat(50) },
  { role: "assistant", content: "done one" },
  { role: "user", content: "turn two" },
  { role: "assistant", content: "done two" },
];
const trimmed = trimMessages(convo, 300);
check("trim keeps system prompt", trimmed[0].role === "system");
check("trim drops whole oldest turn", trimmed.length === 3 && trimmed[1].content === "turn two");
check("trim leaves a small convo alone", trimMessages(convo, 1e6).length === convo.length);
check("no orphaned tool result after trim", !trimmed.some(function (m) { return m.role === "tool"; }));
check("incomplete tool_calls dropped", dropIncompleteTurn(convo.slice(0, 3)).length === 2);
check("tool results without final answer dropped with their call", dropIncompleteTurn(convo.slice(0, 4)).length === 2);
check("complete turn untouched", dropIncompleteTurn(convo).length === convo.length);

// BYOK presets and key masking. A preset that does not parse into a usable
// list would leave the picker empty and MODELS[0] undefined at runtime.
Object.keys(PROVIDER_PRESETS).forEach(function (id) {
  const p = PROVIDER_PRESETS[id];
  const list = parseModelList(p.models, p.agentModel);
  check(id + " preset parses to at least one model", list.length >= 1);
  check(id + " preset offers a vision model", list.some(function (m) { return m.vision; }));
  check(id + " preset agent model is on its own list", list.some(function (m) { return m.id === p.agentModel; }));
  check(id + " preset vision model is on its list and flagged vision", list.some(function (m) { return m.id === p.visionModel && m.vision; }));
  check(id + " preset base url is https", p.baseUrl.indexOf("https://") === 0);
});

// The one that matters: no input length may round-trip the whole key.
const keySamples = ["", "a", "sk-1234", "sk-12345", "sk-123456789", "sk-proj-aaaaaaaaaaaaaaaaaaaa9f2c", "x".repeat(200)];
check("maskKey never returns the full key", keySamples.every(function (k) { return k === "" || maskKey(k) !== k; }));
check("maskKey reveals at most the last 4 characters", keySamples.every(function (k) {
  const m = maskKey(k);
  return m === "" || m === "…" || (m.length === 5 && k.slice(-4) === m.slice(1));
}));
check("maskKey hides short keys entirely", maskKey("sk-12345") === "…");
check("maskKey on empty is empty", maskKey("") === "");
check("maskKey handles non-strings", maskKey(undefined) === "" && maskKey(null) === "");

// Model discovery: GET /v1/models reports ids only, so the merge is what
// supplies vision flags and token budgets.
const discovered = mergeDiscoveredModels(
  ["text-embedding-3-small", "gpt-4o", "whisper-1", "o3-mini", "some-llm-7b", "dall-e-3", "gpt-4o", "tts-1", ""],
  PROVIDER_PRESETS.openai.models
);
const byId = function (id) { return discovered.find(function (m) { return m.id === id; }); };
check("discovery drops embedding/audio/image models", !byId("text-embedding-3-small") && !byId("whisper-1") && !byId("dall-e-3") && !byId("tts-1"));
check("discovery keeps chat models", !!byId("gpt-4o") && !!byId("o3-mini") && !!byId("some-llm-7b"));
check("discovery dedupes repeated ids", discovered.filter(function (m) { return m.id === "gpt-4o"; }).length === 1);
check("discovery ignores blank ids", discovered.every(function (m) { return !!m.id; }));
check("a known id keeps the preset's verified flags", byId("gpt-4o").vision === true && byId("gpt-4o").maxTokens === 16000);
check("a known id is marked known", byId("gpt-4o").known === true && byId("some-llm-7b").known === false);
check("known models sort ahead of guesses", discovered[0].known === true);
check("a reasoning-looking id gets the large budget", byId("o3-mini").reasoning === true && byId("o3-mini").maxTokens === REASONING_MAX_TOKENS);
// the blocker: 32000 is a 400 on most non-reasoning models, so an unknown id
// must never inherit the reasoning budget
check("an unknown non-reasoning id gets the conservative budget", byId("some-llm-7b").maxTokens === DISCOVERED_MAX_TOKENS);
check("conservative budget is well below the reasoning one", DISCOVERED_MAX_TOKENS < REASONING_MAX_TOKENS);
check("no discovered model silently gets 32000 without the reasoning flag", discovered.every(function (m) { return m.maxTokens !== REASONING_MAX_TOKENS || m.reasoning || m.known; }));
check("discovery on an empty list is empty", mergeDiscoveredModels([], "").length === 0 && mergeDiscoveredModels(null, "").length === 0);
check("discovery without a preset still classifies", mergeDiscoveredModels(["my-vision-model", "plain-model"], "").length === 2);

// A text-only endpoint must report no vision model rather than inventing one:
// the server leaves config.model empty and the vision routes say so.
const textOnly = mergeDiscoveredModels(["tiny-chat-1b", "another-text-model"], "");
check("a text-only endpoint yields no vision model", textOnly.length === 2 && !textOnly.some(function (m) { return m.vision; }));

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
