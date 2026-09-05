import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// client.mjs lives outside the host project root, so alias the excalidraw
// package to its entry inside host/node_modules for Rollup to resolve it.
// Exact-match regex so the "@excalidraw/excalidraw/index.css" subpath is left alone.
const excalidrawEntry = fileURLToPath(
  new URL("./node_modules/@excalidraw/excalidraw/dist/prod/index.js", import.meta.url),
);

// same story for the TOON encoder client.mjs uses for query_elements results
const toonEntry = fileURLToPath(new URL("./node_modules/@toon-format/toon/dist/index.mjs", import.meta.url));

// and for the mermaid layout engine behind create_diagram (ships with @excalidraw/excalidraw)
const mermaidEntry = fileURLToPath(
  new URL("./node_modules/@excalidraw/mermaid-to-excalidraw/dist/index.js", import.meta.url),
);

// mermaid 11.17 prefixes subgraph <g> ids with the render id, but
// @excalidraw/mermaid-to-excalidraw 2.2.2 still looks them up by exact id, so
// every flowchart with a `subgraph` silently degrades to a flat image. Nodes
// already use a substring match; give subgraphs the same one. Applied twice:
// in esbuild's dev pre-bundle and in Rollup's production build.
// ponytail: drop this when the converter ships a fix upstream.
const SUBGRAPH_BEFORE = "containerEl.querySelector(`[id='${data.id}']`)";
const SUBGRAPH_AFTER = "(containerEl.querySelector(`[id='${data.id}']`) || containerEl.querySelector(`[id$='-${data.id}']`))";
function fixSubgraphLookup(code) {
  if (!code.includes(SUBGRAPH_BEFORE)) throw new Error("mermaid-subgraph-id-fix: pattern not found, converter changed");
  return code.replace(SUBGRAPH_BEFORE, SUBGRAPH_AFTER);
}
const isFlowchartParser = (file) => /mermaid-to-excalidraw[\\/]dist[\\/]parser[\\/]flowchart\.js$/.test(file);
const subgraphIdFixRollup = {
  name: "mermaid-subgraph-id-fix",
  transform(code, id) {
    return isFlowchartParser(id) ? { code: fixSubgraphLookup(code), map: null } : null;
  },
};
const subgraphIdFixEsbuild = {
  name: "mermaid-subgraph-id-fix",
  setup(build) {
    build.onLoad({ filter: /flowchart\.js$/ }, async (args) => {
      if (!isFlowchartParser(args.path)) return null;
      const { readFile } = await import("node:fs/promises");
      return { contents: fixSubgraphLookup(await readFile(args.path, "utf8")), loader: "js" };
    });
  },
};

export default defineConfig({
  plugins: [react(), subgraphIdFixRollup],
  optimizeDeps: { esbuildOptions: { plugins: [subgraphIdFixEsbuild] } },
  resolve: {
    alias: [
      { find: new RegExp("^@excalidraw/excalidraw$"), replacement: excalidrawEntry },
      { find: new RegExp("^@toon-format/toon$"), replacement: toonEntry },
      { find: new RegExp("^@excalidraw/mermaid-to-excalidraw$"), replacement: mermaidEntry },
    ],
  },
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
