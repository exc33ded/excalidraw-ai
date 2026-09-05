import { createServer } from "node:http";
import { callVisionModel, callChat } from "./vision.mjs";
import { validateSkeleton, DIAGRAM_GENERATION_PROMPT, DESCRIBE_SYSTEM_PROMPT } from "./diagram-contract.mjs";
import { parseModelList } from "./agent-contract.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

const PORT = Number(process.env.PORT || 8787);
// bind to loopback unless told otherwise: the key behind this port is the whole threat model
const HOST = process.env.AI_BRIDGE_HOST || "127.0.0.1";
const TOKEN = process.env.AI_BRIDGE_TOKEN || ""; // optional shared secret for /api/*
const UPSTREAM_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 180000);
const config = {
  baseUrl: process.env.AI_API_URL || "https://api.openai.com/v1",
  apiKey: process.env.AI_API_KEY || "",
  model: process.env.AI_API_MODEL || "gpt-4o",
  agentModel: process.env.AI_AGENT_MODEL || "deepseek-v4-flash",
};
// the allowlist the picker shows and every /api/ai/* route enforces
const MODELS = parseModelList(process.env.AI_MODELS, config.agentModel);
// the configured vision model is always offered, and always as vision
if (!MODELS.some(function (m) { return m.id === config.model; })) MODELS.push({ id: config.model, vision: true, maxTokens: 32000 });

// body.model for the vision routes: must be on the list AND vision-capable
function visionModelFor(body) {
  if (!body.model) return config.model;
  const m = MODELS.find(function (x) { return x.id === body.model && x.vision; });
  return m ? m.id : null;
}

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

// abort the upstream call when the browser gives up (Stop button, closed tab)
// or when the provider hangs. Listen on res, not req: IncomingMessage emits
// "close" as soon as its body is consumed, which readJson already did.
function upstreamSignal(req, res) {
  const ac = new AbortController();
  res.on("close", function () { if (!res.writableEnded) { console.log("client left " + req.url + ", aborting upstream"); ac.abort(); } });
  return AbortSignal.any([ac.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
}

function send(res, code, obj) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, CORS));
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    let body = "";
    req.on("data", function (c) {
      body += c;
      if (body.length > 25e6) { reject(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", function () {
      try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async function (req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }
  if (TOKEN && req.headers.authorization !== "Bearer " + TOKEN) {
    return send(res, 401, { error: "unauthorized" });
  }
  if (req.method === "GET" && req.url === "/api/ai/models") {
    return send(res, 200, { models: MODELS, default: MODELS[0].id, visionDefault: config.model });
  }
  if (req.method === "POST" && req.url === "/api/ai/diagram") {
    try {
      if (!config.apiKey) return send(res, 500, { error: "AI_API_KEY is not set" });
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const hasImage = typeof body.image === "string" && body.image.indexOf("data:image/") === 0;
      if (!text && !hasImage) {
        return send(res, 400, { error: "image (base64 data URL) or text description required" });
      }
      const model = visionModelFor(body);
      if (!model) return send(res, 400, { error: "not a vision model on the allowlist: " + String(body.model).slice(0, 80) });
      let raw;
      if (text) {
        raw = await callVisionModel({ image: hasImage ? body.image : undefined, prompt: text, system: DIAGRAM_GENERATION_PROMPT, config, model, signal: upstreamSignal(req, res) });
      } else {
        raw = await callVisionModel({ image: body.image, prompt: body.prompt, config, model, signal: upstreamSignal(req, res) });
      }
      const result = validateSkeleton(raw && raw.elements);
      if (!result.ok) return send(res, 422, { error: result.error });
      return send(res, 200, { elements: result.elements });
    } catch (e) {
      return send(res, 500, { error: e && e.message ? e.message : "internal error" });
    }
  }
  if (req.method === "POST" && req.url === "/api/ai/chat") {
    try {
      if (!config.apiKey) return send(res, 500, { error: "AI_API_KEY is not set" });
      const body = await readJson(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const tools = Array.isArray(body.tools) ? body.tools : undefined;
      if (!messages.length) return send(res, 400, { error: "messages required" });
      const model = MODELS.find(function (m) { return m.id === body.model; }) || MODELS[0];
      if (body.model && model.id !== body.model) return send(res, 400, { error: "model not allowed: " + String(body.model).slice(0, 80) });
      const message = await callChat({ messages: messages, tools: tools, config, model: model.id, maxTokens: model.maxTokens, signal: upstreamSignal(req, res) });
      return send(res, 200, { message: message });
    } catch (e) {
      return send(res, 500, { error: e && e.message ? e.message : "internal error" });
    }
  }
  // the agent's `capture` tool: screenshot in, words out (its brain has no vision)
  if (req.method === "POST" && req.url === "/api/ai/describe") {
    try {
      if (!config.apiKey) return send(res, 500, { error: "AI_API_KEY is not set" });
      const body = await readJson(req);
      if (typeof body.image !== "string" || body.image.indexOf("data:image/") !== 0) {
        return send(res, 400, { error: "image (base64 data URL) required" });
      }
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const model = visionModelFor(body);
      if (!model) return send(res, 400, { error: "not a vision model on the allowlist: " + String(body.model).slice(0, 80) });
      const raw = await callVisionModel({
        image: body.image,
        prompt: question || "Describe this canvas.",
        system: DESCRIBE_SYSTEM_PROMPT,
        config: config,
        model: model,
        signal: upstreamSignal(req, res),
      });
      const description = raw && typeof raw.description === "string" ? raw.description : "";
      if (!description) return send(res, 422, { error: "model returned no description" });
      return send(res, 200, { description: description });
    } catch (e) {
      return send(res, 500, { error: e && e.message ? e.message : "internal error" });
    }
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, function () {
  console.log("Excalidraw AI bridge listening on http://" + HOST + ":" + PORT + (TOKEN ? " (token required)" : ""));
  console.log("diagram model: " + config.model + " (base: " + config.baseUrl + ")");
  console.log("agent models:  " + MODELS.map(function (m) { return m.id + (m.vision ? " (vision)" : ""); }).join(", "));
});
