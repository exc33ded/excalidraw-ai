// OpenAI-compatible vision call, shaped after Penecho's request builder in
// src/server/main.js: system prompt + user text + image_url(detail:high) and
// response_format json_object.

import { DIAGRAM_SYSTEM_PROMPT } from "./diagram-contract.mjs";

const FENCE = String.fromCharCode(96).repeat(3);

function trimTrailingSlash(s) {
  let t = s;
  while (t.endsWith("/")) t = t.slice(0, -1);
  return t;
}

function stripFences(s) {
  let t = s.trim();
  if (t.indexOf(FENCE) === 0) {
    t = t.slice(3);
    if (t.slice(0, 4).toLowerCase() === "json") t = t.slice(4);
  }
  if (t.slice(-3) === FENCE) t = t.slice(0, -3);
  return t.trim();
}

// The configured models are reasoning models: reasoning_tokens are billed
// against max_tokens before a single character of JSON is emitted, and the
// reasoning length swings a lot run to run (measured 2966..5437 for one short
// prompt). An 8k cap truncated the JSON mid-string on heavy-reasoning runs,
// which surfaced as "model did not return valid JSON". Leave generous headroom.
export function buildVisionRequest({ image, prompt, model, maxTokens = 32000, system }) {
  const userText = prompt || "Transcribe this rough diagram into a clean, editable Excalidraw diagram.";
  const content = [];
  if (image) content.push({ type: "image_url", image_url: { url: image, detail: "high" } });
  content.push({ type: "text", text: userText });
  return {
    model: model,
    stream: false,
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system || DIAGRAM_SYSTEM_PROMPT },
      { role: "user", content: content },
    ],
  };
}

export async function callVisionModel({ image, prompt, config, signal, system, model }) {
  const baseUrl = trimTrailingSlash(config.baseUrl || "https://api.openai.com/v1");
  const url = baseUrl + "/chat/completions";
  const body = buildVisionRequest({ image, prompt, model: model || config.model, system });
  const res = await fetch(url, {
    method: "POST",
    signal: signal || undefined,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + config.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("vision call failed " + res.status + ": " + text.slice(0, 500));
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== "string") {
    throw new Error("unexpected vision response shape");
  }
  // a truncated response is not a malformed one - say which it is
  if (choice.finish_reason === "length") {
    throw new Error("the model ran out of output budget before finishing the diagram (raise maxTokens); try a shorter description");
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    try {
      return JSON.parse(stripFences(content));
    } catch (e2) {
      throw new Error("model did not return valid JSON: " + content.slice(0, 200));
    }
  }
}

// Generic OpenAI-compatible chat call with optional tool-calling support.
// Used by the agent loop (brain = deepseek-v4-flash). Returns the assistant
// message ({ role, content, tool_calls }).
export async function callChat({ messages, tools, config, signal, model, maxTokens }) {
  const baseUrl = trimTrailingSlash(config.baseUrl || "https://api.openai.com/v1");
  const url = baseUrl + "/chat/completions";
  // same reasoning-token budget problem as the vision path: a truncated
  // tool_call arguments string is unparseable JSON. The budget is per model
  // (AI_MODELS), because 32k is a 400 on most non-reasoning models.
  const body = { model: model || config.agentModel || config.model || "deepseek-v4-flash", stream: false, max_tokens: maxTokens || 32000, messages: messages };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(url, {
    method: "POST",
    signal: signal || undefined,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("chat call failed " + res.status + ": " + text.slice(0, 500));
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  if (!message) throw new Error("unexpected chat response shape");
  if (choice.finish_reason === "length") throw new Error("the model ran out of output budget mid-reply (raise this model's max tokens in AI_MODELS)");
  return message;
}
