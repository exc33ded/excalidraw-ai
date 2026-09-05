// Browser tests (real Chrome, real key, both servers running):
//   node server.mjs & (cd host && npm run dev) & CHROME=/path/to/chrome node browser-test.mjs
// Covers what test.mjs cannot: the panel inside .excalidraw, dark mode, key and
// wheel leaks, stop, persistence, revert, and create_diagram (mermaid needs a DOM).
import { createRequire } from "node:module";
const puppeteer = createRequire(new URL("./host/package.json", import.meta.url))("puppeteer-core");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL_ = process.env.HOST_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(URL_, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".ai-sidebar__input", { timeout: 15000 });
await page.waitForFunction(() => /deepseek/.test(document.querySelector(".ai-sidebar__subtitle")?.textContent || ""), { timeout: 15000 });

check("panel is an excalidraw sidebar", await page.$(".excalidraw .sidebar.ai-sidebar") !== null);
await page.click('button[title="Settings"]');
await page.waitForSelector(".ai-sidebar__settings select");
const opts = await page.$$eval(".ai-sidebar__settings select", (sel) => sel.map((s) => Array.from(s.options).map((o) => o.value)));
check("chat picker lists the allowlisted models", opts[0].length === 3 && opts[0].includes("deepseek-v4-pro"));
check("vision picker lists only vision models", opts[1].length === 1 && opts[1][0] === "deepseek-v4-flash-vision-exp");
const chatSel = (await page.$$(".ai-sidebar__settings select"))[0];
await chatSel.select("deepseek-v4-pro");
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-settings")));
check("model choice persisted", saved.chat === "deepseek-v4-pro" && saved.vision === "deepseek-v4-flash-vision-exp");
await chatSel.select("deepseek-v4-flash");
await page.click('button[title="Back to chat"]');

// dark mode follows Excalidraw's own toggle (alt+shift+d)
await page.click("canvas.interactive");
await page.keyboard.down("Alt"); await page.keyboard.down("Shift"); await page.keyboard.press("KeyD"); await page.keyboard.up("Shift"); await page.keyboard.up("Alt");
await sleep(300);
const bgDark = await page.$eval(".ai-sidebar", (el) => getComputedStyle(el).backgroundColor);
const isDark = await page.$eval(".excalidraw", (el) => el.classList.contains("theme--dark"));
check("dark mode toggled via excalidraw", isDark);
await page.keyboard.down("Alt"); await page.keyboard.down("Shift"); await page.keyboard.press("KeyD"); await page.keyboard.up("Shift"); await page.keyboard.up("Alt");
await sleep(300);
const bgLight = await page.$eval(".ai-sidebar", (el) => getComputedStyle(el).backgroundColor);
check("panel background follows theme", bgDark !== bgLight);

// typing 'r' and Delete in the chat box must not touch the canvas tool
await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "r");
await page.keyboard.press("Delete");
const tool = await page.evaluate(() => { const a = document.querySelector('input[name="editor-current-shape"]:checked'); return a ? a.dataset.testid : null; });
check("typing r in chat does not select the rectangle tool", tool === "toolbar-selection");
await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace");

// stop: send, then abort while working
await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "add two rectangles labeled Start and End and connect them");
await page.keyboard.press("Enter");
await page.waitForSelector(".ai-sidebar__stop", { timeout: 5000 });
const stepText = await page.$eval(".ai-sidebar__working", (el) => el.textContent);
check("step label shown while working", /thinking|query|create/.test(stepText));
await page.click(".ai-sidebar__stop");
await sleep(500);
const msgs = await page.$$eval(".ai-sidebar__msg", (m) => m.map((x) => x.textContent));
check("stop yields a Stopped note, not an error", msgs[msgs.length - 1] === "Stopped.");
const hist = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-agent-messages")));
const last = hist[hist.length - 1];
check("history has no orphaned tool call after stop", !(last.role === "tool") && !(last.role === "assistant" && last.tool_calls));

// a real turn: create then rename, then revert
await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "add two rectangles labeled Start and End and connect them with an arrow");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".ai-sidebar__stop"), { timeout: 240000 });
let scene = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene") || "{}"));
await sleep(800);
scene = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene") || "{}"));
const els = scene.elements || [];
check("turn created elements (saved scene)", els.length >= 3);
check("labels are bound text, arrow bound", els.some((e) => e.type === "text" && e.containerId) && els.some((e) => e.type === "arrow" && e.startBinding));
const arrow = els.find((e) => e.type === "arrow");
check("bound arrow has real geometry", arrow && Number.isFinite(arrow.x) && Number.isFinite(arrow.y) && Math.abs(arrow.points[1][0]) + Math.abs(arrow.points[1][1]) > 10);

await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "rename the box labeled Start to Begin");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".ai-sidebar__stop"), { timeout: 240000 });
await sleep(800);
scene = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene") || "{}"));
check("rename changed the bound label", (scene.elements || []).some((e) => e.type === "text" && e.containerId && e.text === "Begin"));

// refresh keeps chat and canvas
const before = await page.$$eval(".ai-sidebar__msg", (m) => m.length);
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".ai-sidebar__msg");
check("chat survives refresh", (await page.$$eval(".ai-sidebar__msg", (m) => m.length)) === before);
await sleep(800);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene") || "{}").elements.length);
check("canvas survives refresh", after === scene.elements.length);

// revert turn
await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "add a diamond labeled Check below End");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".ai-sidebar__stop"), { timeout: 240000 });
await sleep(800);
const withDiamond = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene")).elements.length);
const revertBtn = await page.$('button[title="Revert the last turn"]');
check("revert button present", revertBtn !== null);
await revertBtn.click();
await sleep(800);
const reverted = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene")).elements.length);
check("revert restores pre-turn element count", withDiamond > reverted && reverted === after);

// create_diagram in a real browser (mermaid needs a DOM)
await page.click(".ai-sidebar__input");
await page.type(".ai-sidebar__input", "create a flowchart of a CI pipeline: lint, test, build, deploy");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".ai-sidebar__stop"), { timeout: 300000 });
await sleep(800);
const diag = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-ai-scene")).elements);
check("create_diagram produced bound arrows", diag.filter((e) => e.type === "arrow" && e.startBinding && e.endBinding).length >= 3);

// wheel over the chat must not zoom or pan the canvas
const zoomBefore = await page.$eval(".zoom-actions, [data-testid=zoom-actions], .App-bottom-bar", (el) => el.textContent);
await page.hover(".ai-sidebar__log");
await page.mouse.wheel({ deltaY: 300 });
await page.keyboard.down("Control"); await page.mouse.wheel({ deltaY: -300 }); await page.keyboard.up("Control");
await sleep(300);
const zoomAfter = await page.$eval(".zoom-actions, [data-testid=zoom-actions], .App-bottom-bar", (el) => el.textContent);
check("wheel over the chat does not zoom the canvas", zoomBefore === zoomAfter);

console.log("\n" + pass + " passed, " + fail + " failed");
if (errors.length) console.log("page errors:\n" + errors.join("\n"));
await browser.close();
process.exit(fail ? 1 : 0);
