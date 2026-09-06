// The agent's contract: the persona and the tool schemas the model sees.
// Kept free of any @excalidraw import (like diagram-contract.mjs) so the offline
// tests can check it without a browser. The tool *implementations* live in
// client.mjs, because those need the live excalidrawAPI.

export const AGENT_SYSTEM_PROMPT = "You are an assistant that edits an Excalidraw canvas. The canvas is a set of elements, each with an id, type (rectangle, ellipse, diamond, text, arrow, line), position (x, y), size (width, height), optional text or label, colors, and arrow connections.\n\nWork in a loop: use query_elements to inspect the canvas, then change it with the tools below, then reply with a short summary.\n\nChoosing how to create things:\n- A whole diagram, or anything with more than about four nodes, or anything with a name (transformer architecture, flowchart, CI pipeline, network topology, ER diagram): ALWAYS use create_diagram with mermaid. A layout engine places everything, so boxes never overlap and no connection is missed. Never hand-place a multi-node diagram with create_elements.\n- A few loose shapes, or editing what is already on the canvas: create_elements / update_elements / delete_elements.\n\nWrite mermaid the normal way. Use \"flowchart TD\" for a stack of stages and \"flowchart LR\" for a left-to-right pipeline, and group related stages in subgraph blocks. For example:\n\nflowchart TD\n  I[Inputs] --> IE[Input Embedding + Positional Encoding]\n  subgraph Encoder\n    IE --> EA[Multi-Head Attention] --> EN1[Add and Norm] --> EF[Feed Forward] --> EN2[Add and Norm]\n  end\n  EN2 --> DA\n  subgraph Decoder\n    DA[Masked Multi-Head Attention] --> DN[Add and Norm] --> DF[Feed Forward]\n  end\n  DF --> L[Linear] --> S[Softmax] --> O[Output Probabilities]\n\nIf create_diagram returns a syntax error, fix the mermaid and call it again.\n\nCoordinates are absolute canvas units (pixels). Place new elements near existing ones with a gap of 20-40px so nothing overlaps. Keep boxes roughly 120-160 wide and 60-80 tall.\n\nFor arrows, set start and end to the ids of the elements to connect. When creating a node that an arrow will reference, give it a short unique id (like \"n1\") and use that id in the arrow's start/end.\n\nConnecting shapes that are ALREADY on the canvas into a network (a neural network, a feed-forward or layered diagram, a pipeline): ALWAYS use connect_layers. Read the nodes' x/y, decide which nodes belong to which layer left to right, and pass those groups. \"Feed-forward\" and \"layered\" mean adjacent layers only, never every node to every node to its right - connect_layers enforces that for you and arranges the columns. Never hand-place these connections with create_elements.\n\nWhen the user says \"these\", \"this\", \"them\", or \"the selected\", they mean the current selection, whose ids are listed in the message. If a request is ambiguous, ask one short clarifying question instead of guessing.\n\nquery_elements answers in TOON, a compact table: a header line like elements[3]{id,type,x,y,w,h,text,from,to}: followed by one row per element with the values in that same column order, comma-separated. An empty value means the field does not apply, and quoted values are literal strings. \"from\" and \"to\" are the ids an arrow connects. Read the ids out of the first column.\n\nA shape's \"text\" IS its label: set or change it with update_elements on the shape itself. Labels are never separate elements, so never create, move, or delete a text element to label a shape.\n\nUse set_view to bring part of the canvas into the user's view, and capture when you need to see how the canvas actually looks (overlaps, crowding, alignment) rather than just its coordinates.\n\nTreat the canvas as an existing document: reuse and edit what is already there, and add only what was asked for. Do not recreate content that already exists.";

// Modes: the same tools and canvas rules, a different way of behaving.
// systemPromptFor(mode) = AGENT_SYSTEM_PROMPT + the mode's section.
export const AGENT_MODES = {
  assistant: {
    label: "Assistant",
    hint: "Edits the canvas on request. Short replies.",
    prompt: "Mode: assistant. Do what is asked on the canvas, then reply in 1-2 sentences. Do not describe your reasoning.",
  },
  guide: {
    label: "Guide",
    hint: "Plans with you: roadmaps, architectures, and a written overview.",
    prompt: "Mode: guide. You are a planning assistant. When the user describes something they want to build, learn, or do, first ask at most two clarifying questions if the goal is vague; otherwise proceed. Draw the plan on the canvas (a roadmap, architecture, or flow, via create_diagram), then write a structured overview in the reply: goal, phases or steps, key decisions, risks, and what to do first. Use short headings and bullet points. Length as needed; do not truncate to a sentence.",
  },
  tutor: {
    label: "Tutor",
    hint: "Teaches a topic step by step and checks you understood.",
    prompt: "Mode: tutor. You teach one topic at a time, on the canvas and in the chat.\n1. When the user names a topic or goal, draw a learning roadmap on the canvas (create_diagram, one node per step, 4-8 steps), then ask two things: is this roadmap right for them, and what do they already know. Wait for the answer before teaching.\n2. Teach one step per turn. Explain it in a few short paragraphs with a concrete example, and draw a diagram for it beside the previous content when a picture helps. End every teaching turn with one check question that tests understanding of that step.\n3. Read the user's answer. If they understood, say so briefly and move to the next step. If not, or they ask, re-explain the same step a different way with a simpler example, then check again. Never skip ahead while a step is unclear.\n4. Always say where you are, like 'Step 2 of 6: ...'. When the last step is understood, summarise the whole topic and suggest what to learn next.\nAdapt depth to what the user already knows.",
  },
};

export function systemPromptFor(mode) {
  const m = AGENT_MODES[mode] || AGENT_MODES.assistant;
  return AGENT_SYSTEM_PROMPT + "\n\n" + m.prompt;
}

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "query_elements",
      description: "List canvas elements. Use this first to see what exists and to find element ids. Answers in TOON, not JSON: a header line elements[N]{id,type,x,y,w,h,text,from,to}: followed by one comma-separated row per element, in that column order. Empty string means the field does not apply.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional substring to match against text, label, or type." },
          ids: { type: "array", items: { type: "string" }, description: "Optional specific ids to return." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_elements",
      description: "Add new elements to the canvas: shapes, text, and arrows that connect them (an arrow's start/end are ids of the elements it connects). Returns the new element ids.",
      parameters: {
        type: "object",
        properties: {
          elements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "text", "arrow", "line"] },
                id: { type: "string", description: "Optional short unique id (e.g. n1) so arrows can reference this element." },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                text: { type: "string", description: "Text content. For a text element this is the visible text; for a shape it becomes its label." },
                strokeColor: { type: "string" },
                backgroundColor: { type: "string" },
                fillStyle: { type: "string", enum: ["hachure", "solid"] },
                start: { type: "string", description: "For arrows/lines: id of the element the arrow starts from." },
                end: { type: "string", description: "For arrows/lines: id of the element the arrow ends at." },
                points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "For arrows/lines: optional [x,y] control points." },
              },
              required: ["type"],
            },
          },
        },
        required: ["elements"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_elements",
      description: "Update existing elements by id: move, resize, or change text/colors. Include only the fields to change.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                text: { type: "string" },
                strokeColor: { type: "string" },
                backgroundColor: { type: "string" },
                fillStyle: { type: "string", enum: ["hachure", "solid"] },
              },
              required: ["id"],
            },
          },
        },
        required: ["changes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_elements",
      description: "Delete elements by id. A shape's label is deleted with it automatically.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_layers",
      description: "Wire elements that are ALREADY on the canvas into a layered network: arranges them into evenly spaced columns and connects every node in a layer to every node in the NEXT layer only. Use this for any 'connect these nodes', neural network, feed-forward, pipeline or layered request over existing shapes - it works on hand-drawn shapes too, and tidies rough hand-drawn blobs into clean circles as it goes. You choose the grouping; the positions and connections are computed for you, so a node can never be wired to a node two layers away.",
      parameters: {
        type: "object",
        properties: {
          layers: {
            type: "array",
            description: "The layers left to right. Each entry is the ids of the elements in that layer, ordered top to bottom. Every id must already exist on the canvas.",
            items: { type: "array", items: { type: "string" } },
          },
          arrowheads: { type: "boolean", description: "Draw arrows (default true). Pass false for plain lines with no arrowheads." },
        },
        required: ["layers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_diagram",
      description: "Create a whole laid-out diagram from a mermaid definition. Positions, sizes, arrow routing and grouping are computed by a layout engine, so nothing overlaps and no connection is forgotten. Use this for any diagram of more than about four nodes, and for anything with a name (architecture, flowchart, pipeline, network, sequence, ER). Placed as a new block beside existing content.",
      parameters: {
        type: "object",
        properties: {
          mermaid: { type: "string", description: "A complete mermaid definition, e.g. 'flowchart TD' or 'flowchart LR' followed by node and edge lines. Use subgraph blocks for grouped stages." },
        },
        required: ["mermaid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_view",
      description: "Move the user's viewport to frame something: specific element ids, the current selection, or the whole canvas.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Elements to frame. Omit to frame the current selection, or the whole canvas if nothing is selected." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "capture",
      description: "Look at how the canvas actually renders. Returns a written description of the image (overlaps, crowding, alignment, layout) - use it to verify your own edits, not to read coordinates.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Elements to capture. Omit to capture the current selection, or the whole canvas if nothing is selected." },
          question: { type: "string", description: "What to look for, e.g. 'do any boxes overlap?'" },
        },
      },
    },
  },
];

// AI_MODELS="deepseek-v4-flash,deepseek-v4-flash-vision-exp:vision:16000"
// Each entry is id[:vision][:maxTokens]. The server exposes this list and
// refuses any model not on it, so the browser never names an arbitrary upstream model.
export function parseModelList(str, fallbackId) {
  const out = [];
  String(str || "").split(",").forEach(function (raw) {
    const parts = raw.trim().split(":");
    const id = parts.shift();
    if (!id) return;
    const m = { id: id, vision: false, reasoning: false, maxTokens: 32000 };
    parts.forEach(function (p) {
      if (p === "vision") m.vision = true;
      else if (p === "reasoning") m.reasoning = true;
      else if (/^\d+$/.test(p)) m.maxTokens = Number(p);
    });
    out.push(m);
  });
  if (!out.length && fallbackId) out.push({ id: fallbackId, vision: false, reasoning: false, maxTokens: 32000 });
  return out;
}

// Keep the system prompt and the most recent turns under a character budget.
// A turn is user -> (assistant tool_calls -> tool results)* -> assistant text;
// turns are dropped whole so no tool_call is ever orphaned from its result
// (upstream rejects that with a 400).
export function trimMessages(messages, maxChars) {
  const sys = messages[0] && messages[0].role === "system" ? [messages[0]] : [];
  let rest = messages.slice(sys.length);
  const size = function (list) { return list.reduce(function (n, m) { return n + JSON.stringify(m).length; }, 0); };
  while (rest.length && size(sys) + size(rest) > maxChars) {
    let next = rest.findIndex(function (m, i) { return i > 0 && m.role === "user"; });
    if (next === -1) next = rest.length;
    rest = rest.slice(next);
  }
  return sys.concat(rest);
}

// Stop pressed mid-turn can leave an assistant tool_calls message without its
// tool results; cut back to the last complete turn boundary.
export function dropIncompleteTurn(messages) {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.tool_calls && last.tool_calls.length) return messages.slice(0, -1);
  if (last && last.role === "tool") {
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role === "tool") i--;
    return messages.slice(0, i);
  }
  return messages;
}

// BYOK: the two providers the settings screen offers by name. The client sends
// a preset *name*, never a base URL — an attacker who can reach the config
// route must not be able to repoint the bridge at their own collector.
export const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: "gpt-4o-mini:16000,gpt-4o:vision:16000",
    agentModel: "gpt-4o-mini",
    visionModel: "gpt-4o",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: "deepseek-v4-flash:reasoning,deepseek-v4-pro:reasoning,deepseek-v4-flash-vision-exp:vision:reasoning",
    agentModel: "deepseek-v4-flash",
    visionModel: "deepseek-v4-flash-vision-exp",
    keysUrl: "https://platform.deepseek.com/api_keys",
  },
};

// A key is never sent back to the browser; this is all the UI gets to confirm
// which key is loaded. Reveals at most the last 4 characters, and nothing at
// all for a key short enough that 4 characters would be most of it.
export function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  return s.length > 8 ? "…" + s.slice(-4) : "…";
}

// ---------------------------------------------------------------------------
// Model discovery. GET /v1/models returns only { id, object, created,
// owned_by } - no vision flag, no reasoning flag, no token budget - so a raw
// list would fill the chat picker with embedding and TTS models and leave the
// vision picker guessing. Discovery supplies the candidate ids; the presets
// supply verified flags for the ids they know; the rest fall back to guesses
// plus a deliberately small budget.
// ---------------------------------------------------------------------------

// not chat models, whatever else they are
const NOT_CHAT = /embedding|whisper|tts|dall-e|moderation|rerank|audio|realtime|speech|image-\d|transcribe/i;
const LOOKS_VISION = /vision|gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|llava|pixtral|maverick|scout/i;
const LOOKS_REASONING = /(^|[-/])o[134]([-.]|$)|reason|deepseek-r|thinking|gpt-5|qwq|magistral/i;

// A reasoning model bills reasoning_tokens against max_tokens before emitting
// any content (measured 2966..7897 on one prompt here), so it needs a large
// budget. 32000 is a 400 on most non-reasoning models, hence the split.
export const REASONING_MAX_TOKENS = 32000;
export const DISCOVERED_MAX_TOKENS = 8000;

export function looksReasoning(id) { return LOOKS_REASONING.test(String(id || "")); }
export function looksVision(id) { return LOOKS_VISION.test(String(id || "")); }
export function isChatModel(id) { return !!id && !NOT_CHAT.test(String(id)); }

// ids: what the provider reported. presetModels: the matching preset's model
// string, when the endpoint is a known provider - its flags win over guesses.
export function mergeDiscoveredModels(ids, presetModels) {
  const known = new Map();
  parseModelList(presetModels, "").forEach(function (m) { known.set(m.id, m); });
  const seen = new Set();
  const out = [];
  (ids || []).forEach(function (raw) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id) || !isChatModel(id)) return;
    seen.add(id);
    const reasoning = looksReasoning(id);
    const hit = known.get(id);
    // a known id keeps the preset's verified vision flag and budget
    if (hit) out.push({ id: id, vision: hit.vision, reasoning: hit.reasoning || reasoning, maxTokens: hit.maxTokens, known: true });
    else out.push({ id: id, vision: looksVision(id), reasoning: reasoning, maxTokens: reasoning ? REASONING_MAX_TOKENS : DISCOVERED_MAX_TOKENS, known: false });
  });
  out.sort(function (a, b) { return (b.known ? 1 : 0) - (a.known ? 1 : 0) || a.id.localeCompare(b.id); });
  return out;
}
