// Chat history on disk: one directory per chat, under the user's home so it
// survives `npx excalidraw-ai` (whose package dir is a throwaway cache).
//
// ponytail: plain JSON files and a directory scan. node:sqlite would need
// Node >= 22.13 and package.json still declares >= 20.12; at list/read/write/
// delete of one blob per chat it buys nothing. Move to it when search across
// chats shows up. A vector DB (pinecone et al) is a different product - it
// needs a network and an embedding budget, and nothing here searches.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const DATA_DIR = process.env.AI_DATA_DIR || join(homedir(), ".excalidraw-ai");
const CHATS = join(DATA_DIR, "chats");

// Parts are written independently because their write rates differ by orders
// of magnitude: meta on every save, elements on every stroke, files only when
// an image is added (and those are megabytes of base64).
const EMPTY = { chat: { display: [], messages: [] }, scene: { elements: [] }, files: { files: {} } };

// ids come from randomUUID, but this is the only thing between a request path
// and rmSync, so it is checked rather than trusted
function dirOf(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new Error("bad chat id");
  return join(CHATS, id);
}

function readPart(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")); } catch (e) { return null; }
}

// tmp + rename: the scene is saved on a 500ms debounce while the user draws,
// so a crash mid-write must leave the previous version intact, not a truncated
// one. rename is atomic within a directory.
function writePart(dir, name, value) {
  const file = join(dir, name + ".json");
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export function listChats() {
  mkdirSync(CHATS, { recursive: true });
  return readdirSync(CHATS, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory(); })
    .map(function (d) { return readPart(join(CHATS, d.name), "meta"); })
    .filter(function (m) { return m && m.id; })
    .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
}

export function createChat(title) {
  const id = randomUUID();
  const now = Date.now();
  const meta = { id: id, title: String(title || "New chat").slice(0, 120), createdAt: now, updatedAt: now };
  mkdirSync(dirOf(id), { recursive: true });
  writePart(dirOf(id), "meta", meta);
  return meta;
}

export function readChat(id) {
  const dir = dirOf(id);
  const meta = readPart(dir, "meta");
  if (!meta) return null;
  return {
    meta: meta,
    chat: readPart(dir, "chat") || EMPTY.chat,
    scene: readPart(dir, "scene") || EMPTY.scene,
    files: (readPart(dir, "files") || EMPTY.files).files,
  };
}

// patch keys are optional and independent: saving a stroke does not rewrite
// the transcript, and saving a reply does not rewrite the images
export function writeChat(id, patch) {
  const dir = dirOf(id);
  const meta = readPart(dir, "meta");
  if (!meta) return null;
  if (patch.chat) writePart(dir, "chat", patch.chat);
  if (patch.elements) writePart(dir, "scene", { elements: patch.elements });
  if (patch.files) writePart(dir, "files", { files: patch.files });
  const next = Object.assign({}, meta, { updatedAt: Date.now() });
  if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim().slice(0, 120);
  writePart(dir, "meta", next);
  return next;
}

export function deleteChat(id) {
  rmSync(dirOf(id), { recursive: true, force: true });
}
