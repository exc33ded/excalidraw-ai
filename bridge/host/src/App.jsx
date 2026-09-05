import React, { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, Footer, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { wireExcalidrawAI } from "../../client.mjs";
import AgentPanel, { AgentTrigger } from "./AgentPanel.jsx";
import "./App.css";

// The three keys the single-chat version used. Read once, to seed chat #1 for
// people upgrading, then dropped - the bridge owns this data now.
const LEGACY = { scene: "excalidraw-ai-scene", chat: "excalidraw-ai-chat", messages: "excalidraw-ai-agent-messages" };
const ACTIVE_KEY = "excalidraw-ai-active"; // which chat to reopen on this machine

function legacy(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

export default function App() {
  const [api, setApi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  const [chats, setChats] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [chat, setChat] = useState([]); // the display log; the model transcript lives in client.mjs
  const aiRef = useRef(null);
  const saveTimer = useRef(null);
  const activeRef = useRef(null);       // onChange fires outside React's render, so it reads this
  const transcriptRef = useRef([]);     // latest slim transcript, handed over by client.mjs
  const fileIdsRef = useRef("");        // images are megabytes of base64: only re-send when the set changes
  const loadedRef = useRef(null);       // suppresses the save that a fresh load would otherwise trigger

  const onApi = useCallback((excalidrawAPI) => {
    setApi(excalidrawAPI);
    aiRef.current = wireExcalidrawAI({
      excalidrawAPI,
      token: import.meta.env.VITE_AI_BRIDGE_TOKEN || "",
      onMessages: (messages) => { transcriptRef.current = messages; },
    });
    if (import.meta.env.DEV) { window.excalidrawAPI = excalidrawAPI; window.ai = aiRef.current; }
  }, []);

  // Put a stored chat on screen: canvas, conversation, and the model's own
  // transcript all swap together. Miss any one and the agent answers the next
  // question with the previous chat's history.
  const openChat = useCallback(async (id) => {
    const ai = aiRef.current;
    // a silent return here would leave a created chat listed but never opened,
    // with activeId still on the previous one
    if (!ai || !api) throw new Error("the canvas is not ready yet");
    clearTimeout(saveTimer.current); // a pending save belongs to the chat we are leaving
    const r = await ai.chats.read(id);
    activeRef.current = id;
    loadedRef.current = id;
    transcriptRef.current = r.chat.messages || [];
    fileIdsRef.current = Object.keys(r.files || {}).sort().join(",");
    ai.agent.load(r.chat.messages);
    setActiveId(id);
    setChat(r.chat.display || []);
    // updateScene takes elements; files are a separate store and need addFiles,
    // or every pasted image comes back as a blank rectangle
    api.updateScene({ elements: r.scene.elements || [], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    const files = Object.values(r.files || {});
    if (files.length) api.addFiles(files);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch (e) {}
  }, [api]);

  // first load: reopen the last chat, or make one - seeded from the old
  // single-canvas localStorage if this is an upgrade
  useEffect(() => {
    if (!api || activeRef.current) return;
    (async () => {
      const ai = aiRef.current;
      try {
        let list = await ai.chats.list();
        if (!list.length) {
          const meta = await ai.chats.create("First canvas");
          const scene = legacy(LEGACY.scene);
          const display = legacy(LEGACY.chat);
          const messages = legacy(LEGACY.messages);
          if (scene || display || messages) {
            await ai.chats.save(meta.id, {
              elements: (scene && scene.elements) || undefined,
              files: (scene && scene.files) || undefined,
              chat: { display: display || [], messages: messages || [] },
            });
            Object.values(LEGACY).forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
          }
          list = [meta];
        }
        setChats(list);
        let last = "";
        try { last = localStorage.getItem(ACTIVE_KEY) || ""; } catch (e) {}
        await openChat(list.some((c) => c.id === last) ? last : list[0].id);
      } catch (e) {
        setError("could not load chat history: " + (e.message || e));
      }
    })();
  }, [api, openChat]);

  const newChat = useCallback(async () => {
    const meta = await aiRef.current.chats.create();
    setChats((c) => [meta, ...c]);
    await openChat(meta.id);
  }, [openChat]);

  const removeChat = useCallback(async (id) => {
    await aiRef.current.chats.remove(id);
    const rest = chats.filter((c) => c.id !== id);
    setChats(rest);
    if (id !== activeRef.current) return;
    // never leave the app with no canvas open
    if (rest.length) await openChat(rest[0].id);
    else await newChat();
  }, [chats, openChat, newChat]);

  const onChange = useCallback((elements, appState, files) => {
    const ids = appState.selectedElementIds || {};
    setSelectedCount(elements.filter((e) => !e.isDeleted && ids[e.id]).length);
    if (!activeRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const id = activeRef.current;
      const fileIds = Object.keys(files || {}).sort().join(",");
      const patch = { elements: elements.filter((e) => !e.isDeleted) };
      if (fileIds !== fileIdsRef.current) { patch.files = files; fileIdsRef.current = fileIds; }
      aiRef.current.chats.save(id, patch).catch(() => {}); // a dropped autosave is not worth a dialog
    }, 500);
  }, []);

  // The display log and the model transcript are written together: they are
  // two views of one conversation and must not disagree after a refresh.
  useEffect(() => {
    if (!activeId) return;
    if (loadedRef.current === activeId) { loadedRef.current = null; return; } // this is what we just read
    const id = activeId;
    const display = chat.filter((m) => m.role !== "error").slice(-200);
    const first = display.find((m) => m.role === "user");
    const current = chats.find((c) => c.id === id);
    // the first thing you ask is the best title anyone is going to write
    const title = first && current && current.title === "New chat" ? first.text.slice(0, 60) : undefined;
    aiRef.current.chats.save(id, { chat: { display, messages: transcriptRef.current }, title }).then((r) => {
      if (title) setChats((cs) => cs.map((c) => (c.id === id ? r.meta : c)));
    }).catch(() => {});
  }, [chat, activeId]);

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
      <Excalidraw excalidrawAPI={onApi} onChange={onChange} renderTopRightUI={() => <AgentTrigger />}>
        {/* the chat is an Excalidraw Sidebar, so it must be a child of <Excalidraw> */}
        <AgentPanel
          excalidrawAPI={api}
          ai={aiRef.current}
          chat={chat}
          setChat={setChat}
          chats={chats}
          activeId={activeId}
          onOpenChat={openChat}
          onNewChat={newChat}
          onDeleteChat={removeChat}
        />
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
