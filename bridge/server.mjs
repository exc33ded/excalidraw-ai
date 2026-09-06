import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { callVisionModel, callChat } from "./vision.mjs";
import { validateSkeleton, DIAGRAM_GENERATION_PROMPT, DESCRIBE_SYSTEM_PROMPT } from "./diagram-contract.mjs";
import { parseModelList, PROVIDER_PRESETS, maskKey, mergeDiscoveredModels } from "./agent-contract.mjs";
import { serveStatic, openBrowser, DIST } from "./static.mjs";
import { listChats, createChat, readChat, writeChat, deleteChat } from "./store.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

const PORT = Number(process.env.PORT || 8787);
// bind to loopback unless told otherwise: the key behind this port is the whole threat model
const HOST = process.env.AI_BRIDGE_HOST || "127.0.0.1";
const TOKEN = process.env.AI_BRIDGE_TOKEN || ""; // optional shared secret for /api/*
const UPSTREAM_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 180000);
// vision.mjs reads config.apiKey per call, so mutating this object is all the
// runtime BYOK swap needs - no restart, no re-wiring.
const config = {
  baseUrl: process.env.AI_API_URL || "https://api.openai.com/v1",
  apiKey: process.env.AI_API_KEY || "",
  model: process.env.AI_API_MODEL || "gpt-4o",
  agentModel: process.env.AI_AGENT_MODEL || "deepseek-v4-flash",
};
let provider = ""; // set only when the key came from the settings screen

// the allowlist the picker shows and every /api/ai/* route enforces. Under
// BYOK the user is the operator, so this is no longer a spend boundary - but
// it still carries each model's vision flag and token budget, both load-bearing.
function buildModels(listStr, agentModel, visionModel) {
  const list = parseModelList(listStr, agentModel);
  // the configured vision model is always offered, and always as vision, which
  // is also what keeps the list non-empty for MODELS[0]
  if (!list.some(function (m) { return m.id === visionModel; })) list.push({ id: visionModel, vision: true, maxTokens: 32000 });
  return list;
}
let MODELS = buildModels(process.env.AI_MODELS, config.agentModel, config.model);

// BYOK settings persist here so the app comes back configured. ponytail: plain
// JSON at 0600; move to the OS keychain (Electron safeStorage) when this ships
// as a desktop app.
const CONFIG_FILE = new URL("./config.json", import.meta.url);

function applyProvider(name, apiKey) {
  const preset = PROVIDER_PRESETS[name];
  if (!preset) return false;
  config.baseUrl = preset.baseUrl;
  config.model = preset.visionModel;
  config.agentModel = preset.agentModel;
  if (apiKey) config.apiKey = apiKey;
  MODELS = buildModels(preset.models, preset.agentModel, preset.visionModel);
  provider = name;
  return true;
}

// A tested endpoint reports its own models, so the list replaces the preset's
// rather than extending it. No phantom vision entry here: if the endpoint
// serves no vision model, config.model stays empty and the vision routes say
// so, instead of offering an id the provider would 404 on.
function applyDiscovered(baseUrl, apiKey, models, providerName) {
  config.baseUrl = baseUrl;
  if (apiKey) config.apiKey = apiKey;
  MODELS = models;
  const vision = models.find(function (m) { return m.vision; });
  config.model = vision ? vision.id : "";
  config.agentModel = models[0].id;
  provider = providerName || "custom";
}

// a saved key wins over .env: it is the one the user typed most recently
try {
  const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  if (saved && Array.isArray(saved.models) && saved.models.length) {
    applyDiscovered(saved.baseUrl, saved.apiKey, saved.models, saved.provider);
    console.log("loaded saved settings: " + provider + " " + maskKey(config.apiKey) + ", " + MODELS.length + " models");
  } else if (saved && applyProvider(saved.provider, saved.apiKey)) {
    console.log("loaded saved settings: " + saved.provider + " " + maskKey(config.apiKey));
  }
} catch (e) {}

// One GET does both jobs the settings screen needs: prove the key works and
// report what the endpoint serves. The status code is the whole diagnostic.
// Deliberately not AI_TIMEOUT_MS - 180s on a key test reads as a hang.
const TEST_TIMEOUT_MS = 10000;

async function discoverModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  } catch (e) {
    throw new Error("could not reach " + url + " (" + (e.name === "TimeoutError" ? "timed out after 10s" : e.message) + ")");
  }
  if (res.status === 401 || res.status === 403) throw new Error("the provider rejected this key (" + res.status + ")");
  if (!res.ok) throw new Error("the endpoint answered " + res.status + " - check the base URL");
  const data = await res.json().catch(function () { return null; });
  const list = data && (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null);
  if (!list) throw new Error("the endpoint did not return a model list");
  return list.map(function (m) { return typeof m === "string" ? m : m && m.id; }).filter(Boolean);
}

// body.model for the vision routes: must be on the list AND vision-capable
function visionModelFor(body) {
  if (!body.model) return config.model;
  const m = MODELS.find(function (x) { return x.id === body.model && x.vision; });
  return m ? m.id : null;
}

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

// Writing the provider + key is a trust boundary the read routes are not:
// under the default `*` CORS, any page open in the user's browser could
// otherwise POST its own key here, or (before presets) repoint baseUrl at a
// collector. A browser always sends Origin on a cross-origin POST, so a
// missing Origin means a local non-browser client (curl, Electron main).
const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:" + PORT, "http://127.0.0.1:" + PORT];
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && allowed !== "*") return origin === allowed;
  return LOCAL_ORIGINS.indexOf(origin) !== -1;
}

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
    // With no key there is no provider, so there is nothing to offer. Serving
    // the built-in fallbacks here advertises a configuration nobody chose -
    // a fresh install showed "deepseek-v4-flash" and "gpt-4o" in the pickers.
    if (!config.apiKey) return send(res, 200, { models: [], default: "", visionDefault: "" });
    return send(res, 200, { models: MODELS, default: MODELS[0].id, visionDefault: config.model });
  }
  // first-run detection for the settings screen. Never returns the key itself.
  if (req.method === "GET" && req.url === "/api/ai/status") {
    return send(res, 200, {
      configured: !!config.apiKey,
      provider: provider,
      // a key from .env has no provider name; the panel must not silently
      // preselect a preset whose Save would overwrite a working setup
      fromEnv: !!config.apiKey && !provider,
      baseUrl: config.baseUrl,
      keyHint: maskKey(config.apiKey),
      providers: Object.keys(PROVIDER_PRESETS).map(function (id) {
        return { id: id, label: PROVIDER_PRESETS[id].label, keysUrl: PROVIDER_PRESETS[id].keysUrl };
      }),
    });
  }
  // Try a key + endpoint without saving anything, and report what it serves.
  if (req.method === "POST" && req.url === "/api/ai/test") {
    if (!originOk(req)) return send(res, 403, { error: "cross-origin config writes are refused" });
    try {
      const body = await readJson(req);
      const named = PROVIDER_PRESETS[body.provider];
      // no preset and no URL means "test whatever is loaded right now", which
      // is how a key that came from .env gets checked without being replaced
      const baseUrl = named ? named.baseUrl : (String(body.baseUrl || "").trim() || config.baseUrl);
      // a .env or custom endpoint pointing at a provider we know still gets its
      // verified flags - otherwise the deepseek models come back unflagged
      const trimmed = baseUrl.replace(/\/+$/, "");
      const preset = named || Object.keys(PROVIDER_PRESETS)
        .map(function (k) { return PROVIDER_PRESETS[k]; })
        .find(function (p) { return p.baseUrl.replace(/\/+$/, "") === trimmed; });
      if (!/^https?:\/\//i.test(baseUrl)) return send(res, 400, { error: "a base URL starting with http:// or https:// is required" });
      // an empty key means "test the one already saved"
      const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : config.apiKey;
      if (!apiKey) return send(res, 400, { error: "apiKey required" });
      const ids = await discoverModels(baseUrl, apiKey);
      const models = mergeDiscoveredModels(ids, preset ? preset.models : "");
      if (!models.length) return send(res, 422, { error: "the key works, but this endpoint serves no chat models (saw " + ids.length + " entries)" });
      return send(res, 200, { ok: true, baseUrl: baseUrl, models: models, found: ids.length });
    } catch (e) {
      return send(res, 400, { error: e && e.message ? e.message : "test failed" });
    }
  }
  if (req.method === "POST" && req.url === "/api/ai/config") {
    if (!originOk(req)) return send(res, 403, { error: "cross-origin config writes are refused" });
    try {
      const body = await readJson(req);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      // an empty key when one is already loaded means "keep it, switch provider"
      if (!apiKey && !config.apiKey) return send(res, 400, { error: "apiKey required" });
      // a tested endpoint sends back the list it reported; otherwise it is a preset
      if (Array.isArray(body.models) && body.models.length) {
        const baseUrl = String(body.baseUrl || "").trim();
        if (!/^https?:\/\//i.test(baseUrl)) return send(res, 400, { error: "a base URL starting with http:// or https:// is required" });
        const models = body.models
          .filter(function (m) { return m && typeof m.id === "string"; })
          .map(function (m) { return { id: m.id, vision: !!m.vision, reasoning: !!m.reasoning, maxTokens: Number(m.maxTokens) > 0 ? Number(m.maxTokens) : 8000 }; });
        if (!models.length) return send(res, 400, { error: "models must be a non-empty list of { id }" });
        applyDiscovered(baseUrl, apiKey, models, PROVIDER_PRESETS[body.provider] ? body.provider : "custom");
      } else {
        if (!PROVIDER_PRESETS[body.provider]) return send(res, 400, { error: "unknown provider: " + String(body.provider).slice(0, 40) });
        applyProvider(body.provider, apiKey);
      }
      try {
        writeFileSync(CONFIG_FILE, JSON.stringify({ provider: provider, apiKey: config.apiKey, baseUrl: config.baseUrl, models: MODELS }, null, 2), { mode: 0o600 });
      } catch (e) {
        return send(res, 500, { error: "settings applied but not saved: " + e.message });
      }
      console.log("settings updated: " + provider + " " + maskKey(config.apiKey));
      return send(res, 200, { configured: true, provider: provider, keyHint: maskKey(config.apiKey), models: MODELS, default: MODELS[0].id, visionDefault: config.model });
    } catch (e) {
      return send(res, 500, { error: e && e.message ? e.message : "internal error" });
    }
  }
  if (req.method === "POST" && req.url === "/api/ai/diagram") {
    try {
      if (!config.apiKey) return send(res, 503, { error: "no API key yet - add one in the AI panel's settings" });
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const hasImage = typeof body.image === "string" && body.image.indexOf("data:image/") === 0;
      if (!text && !hasImage) {
        return send(res, 400, { error: "image (base64 data URL) or text description required" });
      }
      const model = visionModelFor(body);
      if (!model) return send(res, 400, { error: body.model ? "not a vision model on the allowlist: " + String(body.model).slice(0, 80) : "this endpoint has no vision model, so Refine and capture are unavailable" });
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
      if (!config.apiKey) return send(res, 503, { error: "no API key yet - add one in the AI panel's settings" });
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
      if (!config.apiKey) return send(res, 503, { error: "no API key yet - add one in the AI panel's settings" });
      const body = await readJson(req);
      if (typeof body.image !== "string" || body.image.indexOf("data:image/") !== 0) {
        return send(res, 400, { error: "image (base64 data URL) required" });
      }
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const model = visionModelFor(body);
      if (!model) return send(res, 400, { error: body.model ? "not a vision model on the allowlist: " + String(body.model).slice(0, 80) : "this endpoint has no vision model, so Refine and capture are unavailable" });
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
  // Chat history. Each chat owns a canvas, so these carry the scene too - the
  // whole point is that reopening a conversation brings its diagram back.
  // originOk applies to the reads as well as the writes: under the default `*`
  // CORS, an unguarded GET would let any page the user has open read their
  // diagrams and conversations.
  const chatRoute = req.url.match(/^\/api\/chats(?:\/([^/?]+))?$/);
  if (chatRoute) {
    if (!originOk(req)) return send(res, 403, { error: "cross-origin chat access is refused" });
    const id = chatRoute[1];
    try {
      if (req.method === "GET" && !id) return send(res, 200, { chats: listChats() });
      if (req.method === "POST" && !id) {
        const body = await readJson(req);
        return send(res, 200, { meta: createChat(body.title) });
      }
      if (req.method === "GET" && id) {
        const chat = readChat(id);
        return chat ? send(res, 200, chat) : send(res, 404, { error: "no such chat" });
      }
      if (req.method === "PUT" && id) {
        const meta = writeChat(id, await readJson(req));
        return meta ? send(res, 200, { meta: meta }) : send(res, 404, { error: "no such chat" });
      }
      if (req.method === "DELETE" && id) {
        deleteChat(id);
        return send(res, 200, { ok: true });
      }
    } catch (e) {
      return send(res, 400, { error: e && e.message ? e.message : "chat store error" });
    }
  }

  // anything that is not an API call is the built app, when there is one
  if (req.method === "GET" && req.url.indexOf("/api/") !== 0) return serveStatic(req, res);
  return send(res, 404, { error: "not found" });
});

// The npx audience cannot read a Node stack trace, and a busy port is the
// most likely first-run failure (another copy, or the dev bridge).
server.on("error", function (e) {
  if (e.code === "EADDRINUSE") {
    console.error("Port " + PORT + " is already in use.");
    console.error("Something else is running there - close it, or choose another port:");
    console.error("  PORT=8788 npx excalidraw-ai");
  } else if (e.code === "EACCES") {
    console.error("Not allowed to listen on port " + PORT + ". Try a port above 1024:");
    console.error("  PORT=8788 npx excalidraw-ai");
  } else {
    console.error("Could not start the server: " + (e.message || e.code));
  }
  process.exit(1);
});

server.listen(PORT, HOST, async function () {
  const url = "http://" + HOST + ":" + PORT;
  const { stat } = await import("node:fs/promises");
  const built = await stat(DIST).then(function () { return true; }).catch(function () { return false; });
  console.log("Excalidraw AI bridge listening on " + url + (TOKEN ? " (token required)" : ""));
  if (built) console.log("open " + url + " in a browser");
  // with no key the model lines are defaults nobody chose, and printing them
  // before "no API key" reads as if it were already set up
  if (config.apiKey) {
    console.log("diagram model: " + config.model + " (base: " + config.baseUrl + ")");
    console.log("agent models:  " + MODELS.map(function (m) { return m.id + (m.vision ? " (vision)" : ""); }).join(", "));
  } else {
    console.log("No API key yet. Open the app, click the gear in the AI panel, and add one.");
  }
  // only the npx entry sets AI_OPEN, so `node server.mjs` keeps its dev behaviour
  if (built && process.env.AI_OPEN === "1" && !process.argv.includes("--no-open")) openBrowser(url);
});
