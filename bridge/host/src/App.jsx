import React, { useCallback, useRef, useState } from "react";
import { Excalidraw, Footer } from "@excalidraw/excalidraw";
import { wireExcalidrawAI } from "../../client.mjs";
import AgentPanel, { AgentTrigger } from "./AgentPanel.jsx";
import "./App.css";

const SCENE_KEY = "excalidraw-ai-scene";

// a persisted chat that refers to element ids is useless if the canvas itself
// is gone on refresh, so the scene is saved too
function loadScene() {
  try { return JSON.parse(localStorage.getItem(SCENE_KEY)) || null; } catch (e) { return null; }
}

export default function App() {
  const [api, setApi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  const aiRef = useRef(null);
  const saveTimer = useRef(null);

  const onApi = useCallback((excalidrawAPI) => {
    setApi(excalidrawAPI);
    aiRef.current = wireExcalidrawAI({ excalidrawAPI, token: import.meta.env.VITE_AI_BRIDGE_TOKEN || "" });
    // dev console access: window.excalidrawAPI.getSceneElements(), window.ai.agent.send("...")
    if (import.meta.env.DEV) { window.excalidrawAPI = excalidrawAPI; window.ai = aiRef.current; }
  }, []);

  const onChange = useCallback((elements, appState, files) => {
    const ids = appState.selectedElementIds || {};
    setSelectedCount(elements.filter((e) => !e.isDeleted && ids[e.id]).length);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem(SCENE_KEY, JSON.stringify({ elements: elements.filter((e) => !e.isDeleted), files })); }
      catch (e) {} // ponytail: quota exceeded (large images) just skips this save; IndexedDB if that bites
    }, 500);
  }, []);

  const run = useCallback(async (fn) => {
    if (!aiRef.current) return;
    setBusy(true);
    setError("");
    try { await fn(aiRef.current); }
    catch (e) { setError(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); }
  }, []);

  const refine = useCallback(() => run((ai) => ai.refine()), [run]);
  const accept = useCallback(() => run((ai) => ai.accept()), [run]);
  const reject = useCallback(() => run((ai) => ai.reject()), [run]);

  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw excalidrawAPI={onApi} initialData={loadScene} onChange={onChange} renderTopRightUI={() => <AgentTrigger />}>
        {/* the chat is an Excalidraw Sidebar, so it must be a child of <Excalidraw> */}
        <AgentPanel excalidrawAPI={api} ai={aiRef.current} />
        {/* Footer is a native slot inside .excalidraw, so these controls sit in
            Excalidraw's own UI layer instead of floating over its toolbars.
            Text -> diagram lives in the chat panel now; what is left is the
            sketch -> clean-diagram path, which the chat does not cover. */}
        <Footer>
          <div className="ai-bar" onKeyDown={(e) => e.stopPropagation()}>
            <button
              className="ai-bar__btn"
              onClick={refine}
              disabled={!api || busy || !selectedCount}
              title={selectedCount ? "Redraw the selected sketch as a clean diagram" : "Select a sketch first (ctrl+A for everything)"}
            >
              Refine{selectedCount ? " " + selectedCount + " selected" : " selection"}
            </button>
            <button className="ai-bar__btn" onClick={accept} disabled={busy}>Accept</button>
            <button className="ai-bar__btn" onClick={reject} disabled={busy}>Reject</button>
            {busy && <span className="ai-bar__note">working...</span>}
            {error && <span className="ai-bar__error">{error}</span>}
          </div>
        </Footer>
      </Excalidraw>
    </div>
  );
}
