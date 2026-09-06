import React, { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "@excalidraw/excalidraw";
import { AGENT_MODES } from "../../agent-contract.mjs";
import "./AgentPanel.css";

export const SIDEBAR_NAME = "ai";
const SETTINGS_KEY = "excalidraw-ai-settings"; // { chat, vision, docked, mode }

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

const ICON = {
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>,
  history: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>,
  undo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  stop: <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>,
  spark: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z"/></svg>,
};

// Renders as an Excalidraw <Sidebar>, so it IS Excalidraw UI: same island,
// header, dock/close buttons, fonts, and dark mode. No theme code here.
export default function AgentPanel({ excalidrawAPI, ai, chat, setChat, chats, activeId, onOpenChat, onNewChat, onDeleteChat }) {
  const [settings, setSettings] = useState(() => Object.assign({ chat: "", vision: "", docked: true, mode: "assistant" }, stored(SETTINGS_KEY, {})));
  const [view, setView] = useState("chat"); // "chat" | "settings" | "history"
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false); // false | step label
  const [models, setModels] = useState(null); // null = loading, [] = failed
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState(null); // { configured, provider, keyHint, providers }
  const [keyDraft, setKeyDraft] = useState("");
  const [providerDraft, setProviderDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [tested, setTested] = useState(null); // { baseUrl, models, found } from a successful test
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [canRevert, setCanRevert] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const logRef = useRef(null);
  const rootRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);

  // grow the box with the text (up to the CSS max-height), shrink when cleared
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [input, view]);

  const update = useCallback((patch) => {
    setSettings((s) => { const next = Object.assign({}, s, patch); store(SETTINGS_KEY, next); return next; });
  }, []);

  // shared by first load and by saving a key, which swaps the whole list
  const applyModelList = useCallback((r) => {
    setModels(r.models);
    setLoadError("");
    setSettings((s) => {
      const has = (id) => r.models.some((m) => m.id === id);
      const vision = r.models.filter((m) => m.vision);
      const next = Object.assign({}, s, {
        chat: has(s.chat) ? s.chat : r.default,
        vision: has(s.vision) ? s.vision : (r.visionDefault || (vision[0] && vision[0].id) || ""),
      });
      store(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!ai) return;
    ai.agent.models().then(applyModelList).catch((e) => { setModels([]); setLoadError(e.message); });
    ai.agent.status().then(setStatus).catch(() => {});
  }, [ai, applyModelList]);

  // Test first: one GET to the provider's /models both proves the key works
  // and reports what it serves. Nothing is saved until the user confirms.
  const testKey = useCallback(async (providerId, baseUrl) => {
    setKeyBusy(true);
    setKeyError("");
    setTested(null);
    try {
      setTested(await ai.agent.test({ provider: providerId === "custom" || providerId === "env" ? "" : providerId, baseUrl, apiKey: keyDraft }));
    } catch (e) {
      setKeyError(e.message);
    } finally {
      setKeyBusy(false);
    }
  }, [ai, keyDraft]);

  const saveKey = useCallback(async (providerId) => {
    setKeyBusy(true);
    setKeyError("");
    try {
      const r = await ai.agent.setup({
        provider: providerId === "custom" || providerId === "env" ? "" : providerId,
        apiKey: keyDraft,
        baseUrl: tested ? tested.baseUrl : "",
        models: tested ? tested.models : undefined,
      });
      setStatus((s) => Object.assign({}, s, { configured: r.configured, provider: r.provider, keyHint: r.keyHint }));
      setKeyDraft("");
      setTested(null);
      applyModelList(r);
    } catch (e) {
      setKeyError(e.message);
    } finally {
      setKeyBusy(false);
    }
  }, [ai, keyDraft, tested, applyModelList]);

  useEffect(() => { if (ai) ai.configure({ visionModel: settings.vision }); }, [ai, settings.vision]);

  useEffect(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.toggleSidebar({ name: SIDEBAR_NAME, force: true });
  }, [excalidrawAPI]);

  // Excalidraw binds wheel natively on its container and treats a textarea
  // target as canvas input; a native listener on our root stops that.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  });

  useEffect(() => {
    if (!excalidrawAPI) return;
    return excalidrawAPI.onChange((elements, appState) => {
      const ids = appState.selectedElementIds || {};
      const live = new Set(elements.filter((e) => !e.isDeleted).map((e) => e.id));
      setSelectedCount(Object.keys(ids).filter((id) => ids[id] && live.has(id)).length);
    });
  }, [excalidrawAPI]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat, busy, view]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !ai || busy) return;
    setChat((c) => [...c, { role: "user", text }]);
    setInput("");
    setBusy("thinking");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const model = (models || []).find((m) => m.id === settings.chat);
      const r = await ai.agent.send(text, { model, mode: settings.mode, signal: ac.signal, onStep: setBusy });
      setChat((c) => [...c, { role: "assistant", text: r.reply || "(no reply)" }]);
    } catch (e) {
      const stopped = e && e.name === "AbortError";
      setChat((c) => [...c, { role: stopped ? "note" : "error", text: stopped ? "Stopped." : e && e.message ? e.message : String(e) }]);
    } finally {
      abortRef.current = null;
      setBusy(false);
      setCanRevert(true);
    }
  }, [input, ai, busy, models, settings.chat, settings.mode]);

  const stop = useCallback(() => abortRef.current && abortRef.current.abort(), []);

  const revert = useCallback(() => {
    if (ai && ai.agent.revert()) setChat((c) => [...c, { role: "note", text: "Reverted the last turn." }]);
    setCanRevert(false);
  }, [ai]);

  const reset = useCallback(() => {
    if (ai) ai.agent.reset();
    setChat([]);
    setCanRevert(false);
  }, [ai]);

  const chatModel = (models || []).find((m) => m.id === settings.chat);
  const mode = AGENT_MODES[settings.mode] ? settings.mode : "assistant";
  const suggestions = {
    assistant: ["add two nodes labeled Input and Output", "connect these with an arrow", "rename the box labeled Start to Begin", "draw a CI pipeline flowchart", "does anything overlap?"],
    guide: ["I want to build a habit-tracking app solo in 3 months", "plan a migration from a monolith to services", "design the data model for a booking system"],
    tutor: ["teach me how transformers work", "I want to learn system design basics", "explain TCP handshakes to me step by step"],
  }[mode];
  const visionModels = (models || []).filter((m) => m.vision);
  // A key from bridge/.env has no preset behind it, so it gets its own entry:
  // without one the picker would show whichever preset happens to be first and
  // Save would quietly swap a working endpoint for that one.
  const fromEnv = !!(status && status.fromEnv);
  const providers = (fromEnv ? [{ id: "env", label: "From bridge/.env" }] : [])
    .concat((status && status.providers) || [])
    .concat([{ id: "custom", label: "Other (OpenAI-compatible)" }]);
  const activeProvider = providerDraft || (status && status.provider) || (providers[0] && providers[0].id) || "";
  const isCustom = activeProvider === "custom";
  const isEnv = activeProvider === "env";
  const keysUrl = (providers.find((p) => p.id === activeProvider) || {}).keysUrl || "";
  const savedProviderLabel = (providers.find((p) => p.id === (status && status.provider)) || {}).label || "";
  // switching provider with a key already saved reuses it; the server keeps the
  // old key when apiKey comes back empty
  const hasKey = !!keyDraft.trim() || !!(status && status.configured);
  const canTest = !keyBusy && hasKey && (!isCustom || /^https?:\/\//i.test(baseUrlDraft.trim()));
  // a custom endpoint must be tested first - that test is where its model list
  // comes from, since there is no preset to fall back on. The .env entry is
  // testable but never saveable: saving it would mean picking a preset for it.
  const canSaveKey = !keyBusy && hasKey && !isEnv && (tested ? true : !isCustom);
  const needsKey = !!status && !status.configured;
  const testedVision = tested ? tested.models.filter((m) => m.vision).length : 0;
  const testedReasoning = tested ? tested.models.filter((m) => m.reasoning).length : 0;

  return (
    <Sidebar
      name={SIDEBAR_NAME}
      className="ai-sidebar"
      docked={settings.docked}
      onDock={(docked) => update({ docked })}
      ref={rootRef}
    >
      <Sidebar.Header>
        {view !== "chat" ? (
          <button className="ai-sidebar__iconbtn" onClick={() => setView("chat")} title="Back to chat" aria-label="Back to chat">{ICON.back}</button>
        ) : null}
        <div className="ai-sidebar__title">
          {view === "settings" ? "AI settings" : view === "history" ? "Chats" : "AI agent"}
          {view === "chat" && (
            <span className="ai-sidebar__subtitle" title={loadError || settings.chat}>
              {AGENT_MODES[mode].label} · {loadError ? "models unavailable" : needsKey ? "no API key" : settings.chat || (models === null ? "loading models" : "no models")}
            </span>
          )}
        </div>
        {view === "history" && (
          <div className="ai-sidebar__tools">
            <button className="ai-sidebar__iconbtn" onClick={() => { onNewChat(); setView("chat"); }} title="New chat" aria-label="New chat">{ICON.plus}</button>
          </div>
        )}
        {view === "chat" && (
          <div className="ai-sidebar__tools">
            <button className="ai-sidebar__iconbtn" onClick={() => setView("history")} title="Chats" aria-label="Chats">{ICON.history}</button>
            {canRevert && !busy && (
              <button className="ai-sidebar__iconbtn" onClick={revert} title="Revert the last turn" aria-label="Revert the last turn">{ICON.undo}</button>
            )}
            <button className="ai-sidebar__iconbtn" onClick={reset} disabled={!!busy || !chat.length} title="Clear conversation" aria-label="Clear conversation">{ICON.trash}</button>
            <button className="ai-sidebar__iconbtn" onClick={() => setView("settings")} title="Settings" aria-label="Settings">{ICON.gear}</button>
          </div>
        )}
      </Sidebar.Header>

      {view === "history" ? (
        <div className="ai-sidebar__chats">
          <p className="ai-sidebar__hint">Each chat owns its own canvas. Opening one brings its diagram back.</p>
          {chats.map((c) => (
            <div key={c.id} className={"ai-sidebar__chatrow" + (c.id === activeId ? " ai-sidebar__chatrow--on" : "")}>
              <button className="ai-sidebar__chatopen" onClick={() => { onOpenChat(c.id); setView("chat"); }} disabled={!!busy}>
                <span className="ai-sidebar__chatname">{c.title}</span>
                <span className="ai-sidebar__chatdate">{new Date(c.updatedAt).toLocaleDateString()}</span>
              </button>
              <button className="ai-sidebar__iconbtn" onClick={() => onDeleteChat(c.id)} disabled={!!busy} title={"Delete " + c.title} aria-label={"Delete " + c.title}>{ICON.trash}</button>
            </div>
          ))}
          <button className="ai-sidebar__suggest" onClick={() => { onNewChat(); setView("chat"); }} disabled={!!busy}>+ New chat</button>
        </div>
      ) : view === "settings" ? (
        <div className="ai-sidebar__settings">
          <label className="ai-sidebar__field">
            <span>Provider</span>
            <small>
              {!status || !status.configured
                ? "Your key is stored on this machine and only ever sent to the provider."
                : fromEnv
                  ? "Using the key in bridge/.env · " + status.keyHint + ". Pick a provider below to set one from here instead."
                  : "Key saved for " + (savedProviderLabel || status.provider) + " · " + status.keyHint}
            </small>
            <select value={activeProvider} onChange={(e) => { setProviderDraft(e.target.value); setTested(null); setKeyError(""); }} disabled={keyBusy || !providers.length}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {isEnv && status.baseUrl && (
            <p className="ai-sidebar__hint">Endpoint: <code>{status.baseUrl}</code>. Test connection checks this key and lists what it serves.</p>
          )}
          {isCustom && (
            <label className="ai-sidebar__field">
              <span>Endpoint</span>
              <small>The OpenAI-compatible base URL, ending before <code>/chat/completions</code>.</small>
              <input
                type="text"
                value={baseUrlDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.example.com/v1"
                onChange={(e) => { setBaseUrlDraft(e.target.value); setTested(null); }}
                disabled={keyBusy}
              />
            </label>
          )}
          <label className="ai-sidebar__field">
            <span>API key</span>
            <small>
              {keysUrl ? <>Get one at <a href={keysUrl} target="_blank" rel="noreferrer">{keysUrl.replace("https://", "")}</a>.</> : "Paste the key from your provider."}
            </small>
            <input
              type="password"
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              placeholder={status && status.configured ? "Saved · paste a new key to replace" : "sk-..."}
              onChange={(e) => { setKeyDraft(e.target.value); setTested(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && canTest) { e.preventDefault(); testKey(activeProvider, baseUrlDraft.trim()); } }}
              disabled={keyBusy}
            />
          </label>
          <div className="ai-sidebar__actions">
            <button className="ai-sidebar__test" onClick={() => testKey(activeProvider, baseUrlDraft.trim())} disabled={!canTest}>
              {keyBusy && !tested ? "Testing…" : "Test connection"}
            </button>
            <button className="ai-sidebar__save" onClick={() => saveKey(activeProvider)} disabled={!canSaveKey}>
              {status && status.configured && !tested ? "Update key" : "Save"}
            </button>
          </div>
          {keyError && <p className="ai-sidebar__hint ai-sidebar__hint--error">{keyError}</p>}
          {tested && (
            <div className="ai-sidebar__tested">
              <p className="ai-sidebar__tested-head">
                Key works · {tested.models.length} usable model{tested.models.length === 1 ? "" : "s"}
                {tested.found > tested.models.length ? " (" + (tested.found - tested.models.length) + " non-chat hidden)" : ""}
              </p>
              <ul>
                {tested.models.slice(0, 12).map((m) => (
                  <li key={m.id}>
                    <code>{m.id}</code>
                    {m.vision && <span className="ai-sidebar__tag">vision</span>}
                    {m.reasoning && <span className="ai-sidebar__tag">reasoning</span>}
                  </li>
                ))}
                {tested.models.length > 12 && <li className="ai-sidebar__tested-more">+{tested.models.length - 12} more</li>}
              </ul>
              <p className="ai-sidebar__hint">
                {testedVision === 0
                  ? "No vision model here, so Refine and the capture tool will be unavailable."
                  : testedVision + " can see images. "}
                {testedReasoning > 0 && testedReasoning + " look like reasoning models and get a 32k output budget."}
                {canSaveKey ? " Save to use this list." : isEnv ? " Pick a provider above to switch away from .env." : ""}
              </p>
            </div>
          )}
          <hr className="ai-sidebar__rule" />
          {needsKey ? (
            <p className="ai-sidebar__hint">Model pickers appear once a key is saved — the list comes from your provider.</p>
          ) : (<>
          <label className="ai-sidebar__field">
            <span>Chat model</span>
            <small>Runs the agent loop and edits the canvas.</small>
            <select value={settings.chat} onChange={(e) => update({ chat: e.target.value })} disabled={!!busy || !models}>
              {(models || []).map((m) => <option key={m.id} value={m.id}>{m.id}{m.reasoning ? " · reasoning" : ""}</option>)}
            </select>
          </label>
          <label className="ai-sidebar__field">
            <span>Vision model</span>
            <small>Reads screenshots for Refine and for the agent's capture tool.</small>
            <select value={settings.vision} onChange={(e) => update({ vision: e.target.value })} disabled={!!busy || !models}>
              {visionModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </label>
          {chatModel && chatModel.vision && (
            <p className="ai-sidebar__hint">The chat model can see: captures go to it directly instead of through the vision model.</p>
          )}
          </>)}
          {loadError && <p className="ai-sidebar__hint ai-sidebar__hint--error">{loadError}</p>}
          {!needsKey && (<p className="ai-sidebar__hint">
            Picking a provider sets its model list. To offer different models, set <code>AI_MODELS</code> in <code>bridge/.env</code> (<code>id:vision:maxTokens</code>) and restart the bridge.
          </p>)}
        </div>
      ) : (
        <>
          {needsKey && (
            <button className="ai-sidebar__banner" onClick={() => setView("settings")}>
              Add an API key to get started →
            </button>
          )}
          <div className="ai-sidebar__log" ref={logRef}>
            {chat.length === 0 && (
              <div className="ai-sidebar__empty">
                <div className="ai-sidebar__empty-icon">{ICON.spark}</div>
                <p>{AGENT_MODES[mode].hint} Select elements first to talk about <em>these</em>.</p>
                {suggestions.map((s) => (
                  <button key={s} className="ai-sidebar__suggest" onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className={"ai-sidebar__msg ai-sidebar__msg--" + m.role}>{m.role === "assistant" ? renderLite(m.text) : m.text}</div>
            ))}
            {busy && (
              <div className="ai-sidebar__working">
                <span className="ai-sidebar__dots" /> {busy}
                <button className="ai-sidebar__stop" onClick={stop}>{ICON.stop} Stop</button>
              </div>
            )}
          </div>

          <div className="ai-sidebar__foot">
            <div className="ai-sidebar__modes" role="tablist" aria-label="mode">
              {Object.keys(AGENT_MODES).map((k) => (
                <button key={k} role="tab" aria-selected={k === mode} className={"ai-sidebar__mode" + (k === mode ? " ai-sidebar__mode--on" : "")} onClick={() => update({ mode: k })} disabled={!!busy} title={AGENT_MODES[k].hint}>
                  {AGENT_MODES[k].label}
                </button>
              ))}
              {selectedCount > 0 && <span className="ai-sidebar__selection">{selectedCount} selected</span>}
            </div>
            <div className="ai-sidebar__row">
              <textarea
                ref={inputRef}
                className="ai-sidebar__input"
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                placeholder="Ask the canvas..."
              />
              <button className="ai-sidebar__send" onClick={send} disabled={!!busy || !input.trim()} title="Send (Enter)" aria-label="Send">{ICON.send}</button>
            </div>
          </div>
        </>
      )}
    </Sidebar>
  );
}

// ponytail: bold, inline code, headings and bullets are enough for the guide
// and tutor replies; a markdown library is the upgrade if tables ever matter
function renderLite(text) {
  return text.split("\n").map((line, i) => {
    let cls = "";
    let body = line;
    if (/^#{1,3}\s/.test(line)) { cls = "ai-md__h"; body = line.replace(/^#{1,3}\s/, ""); }
    else if (/^\s*[-*]\s/.test(line)) { cls = "ai-md__li"; body = line.replace(/^\s*[-*]\s/, ""); }
    else if (/^\s*\d+[.)]\s/.test(line)) { cls = "ai-md__li ai-md__li--n"; }
    const parts = body.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, j) => {
      if (p.startsWith("**")) return <strong key={j}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("`")) return <code key={j}>{p.slice(1, -1)}</code>;
      return p;
    });
    return <div key={i} className={cls || undefined}>{body ? parts : "\u00a0"}</div>;
  });
}

export function AgentTrigger() {
  return (
    <Sidebar.Trigger name={SIDEBAR_NAME} icon={ICON.spark} title="AI agent">
      <span className="sidebar-trigger__label">AI</span>
    </Sidebar.Trigger>
  );
}
