// Live text -> diagram smoke test. Reads bridge/.env.
import { callVisionModel } from "./vision.mjs";
import { validateSkeleton, DIAGRAM_GENERATION_PROMPT } from "./diagram-contract.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

const config = { baseUrl: process.env.AI_API_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_API_MODEL };
const desc = "a neural network diagram";

try {
  const raw = await callVisionModel({ prompt: desc, system: DIAGRAM_GENERATION_PROMPT, config });
  console.log("RAW:", JSON.stringify(raw).slice(0, 300));
  const result = validateSkeleton(raw && raw.elements);
  console.log("VALID:", result.ok);
  if (result.ok) console.log(JSON.stringify(result.elements, null, 2));
  else console.log("ERROR:", result.error);
} catch (e) {
  console.log("FAILED:", (e && e.message ? e.message : String(e)).slice(0, 800));
}
