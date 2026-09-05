// List available models and validate the key. Reads bridge/.env, never prints the key.
try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

const base = (process.env.AI_API_URL || "https://api.deepseek.com/v1");
const res = await fetch(base + "/models", {
  headers: { Authorization: "Bearer " + process.env.AI_API_KEY },
});
if (!res.ok) {
  console.error("HTTP " + res.status + ": " + (await res.text()).slice(0, 400));
  process.exit(1);
}
const j = await res.json();
const ids = (j.data || []).map(function (m) { return m.id; });
console.log(ids.join("\n"));
