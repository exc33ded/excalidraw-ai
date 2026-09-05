// Serving the built host from the bridge, so `npx excalidraw-ai` is one
// process on one port instead of two servers and a proxy. In development
// nothing here runs: Vite serves :5173 and proxies /api to this server.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize, extname, sep } from "node:path";

export const DIST = join(fileURLToPath(new URL("./host/", import.meta.url)), "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

// A URL path is attacker-controlled input, so this is the one place in the
// static path that must not be lazy: resolve, then prove the result is still
// inside the build directory. "/../.env" and its encoded forms all fail here.
export function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || "/").split("?")[0].split("#")[0]);
  } catch (e) {
    return null; // malformed percent-encoding
  }
  if (decoded.indexOf("\0") !== -1) return null;
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

const NO_BUILD =
  "No built app found. Either run the Vite dev server (cd bridge/host && npm run dev, " +
  "then use http://localhost:5173), or build it once: cd bridge/host && npm run build.";

async function fileAt(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s : null;
  } catch (e) {
    return null;
  }
}

export async function serveStatic(req, res) {
  const index = join(DIST, "index.html");
  if (!(await fileAt(index))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(NO_BUILD);
  }
  const target = safeJoin(DIST, req.url);
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("bad path");
  }
  // one route, so anything that is not a real file is the app itself
  const hit = (await fileAt(target)) ? target : index;
  const ext = extname(hit).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    // hashed asset names are safe to cache hard; index.html must not be
    "Cache-Control": hit === index ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(hit).pipe(res);
}

// Opening a browser is three different commands and no dependency worth adding.
export function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  import("node:child_process").then(function (cp) {
    try { cp.spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch (e) {}
  });
}
