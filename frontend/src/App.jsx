import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  User,
  Wrench,
  Plus,
  Trash2,
  History,
  X,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

const TOOL_META = {
  search_web: { verb: "Searching Web", short: "Web" },
  search_documents: { verb: "Searching Docs", short: "Docs" },
  query_database: { verb: "Querying Database", short: "SQL" },
  get_stock_quote: { verb: "Getting Stock Quote", short: "Quote" },
};

const SUGGESTIONS = [
  "Which products are low on stock, under 10 units?",
  "What is your return policy for damaged items?",
  "What is the cheapest Audio product in stock?",
];
const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_CHARS = 28_000;
const MAX_MESSAGE_CONTEXT_CHARS = 4_000;
const MAX_TOOL_CONTEXT_CHARS = 1_800;

function inputSummary(tool, input) {
  const raw =
    tool === "query_database"
      ? input?.sql_query || ""
      : tool === "get_stock_quote"
        ? input?.ticker || ""
        : input?.query || "";
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function ToolPill({ run }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[run.tool] || { verb: run.tool, short: run.tool };
  const done = run.status === "done";
  const failed = run.status === "failed";
  const expandable = done || failed;
  return (
    <div
      className={`mb-2 overflow-hidden rounded-xl border text-sm ${
        failed
          ? "border-rose-800/60 bg-rose-950/40"
          : done
          ? "border-emerald-800/60 bg-emerald-950/40"
          : "border-amber-800/60 bg-amber-950/30"
      }`}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${failed ? "Failed" : done ? "Completed" : "Running"} ${meta.verb}${expandable ? "; toggle details" : ""}`}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {failed ? (
          <AlertCircle size={15} className="shrink-0 text-rose-400" />
        ) : done ? (
          <CheckCircle2 size={15} className="shrink-0 text-emerald-400" />
        ) : (
          <Loader2 size={15} className="shrink-0 animate-spin text-amber-300" />
        )}
        <Wrench size={13} className="shrink-0 opacity-60" />
        <span className="truncate">
          {failed ? "Failed: " : done ? "Completed: " : "Running: "}
          {meta.verb} for ‘{inputSummary(run.tool, run.input)}’
          {expandable ? "" : "…"}
        </span>
        {expandable && (
          <ChevronDown
            size={15}
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      {expandable && open && (
        <pre className={`max-h-64 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs text-slate-300 ${failed ? "border-rose-900/50" : "border-emerald-900/50"}`}>
          {run.output || (failed ? "Tool failed without an error message." : "(empty result)")}
        </pre>
      )}
    </div>
  );
}

let idCounter = 1;
const nextId = () => idCounter++;

const DRAFT_KEY = "omniagent-draft-v1";
const LEGACY_KEY = "omniagent-history-v1"; // pre-sidebar drafts migrate once
const ARCHIVE_KEY = "omniagent-archive-v1";
const SESSION_FLAG = "omniagent-live-tab";
const MAX_STORED_MESSAGES = 30;
const MAX_ARCHIVED_CHATS = 20;

function sanitizeMessages(value) {
  if (!Array.isArray(value)) return [];
  let maxId = 0;
  const clean = [];
  for (const m of value) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const id = typeof m.id === "number" && m.id > 0 ? m.id : nextId();
    if (id > maxId) maxId = id;
    const tools = Array.isArray(m.tools) ? m.tools : [];
    clean.push({
      id,
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 8000) : "",
      tools: tools
        .filter((t) => t && typeof t === "object")
        .map((t) => {
          const running = t.status === "running";
          return {
            key: String(t.key ?? t.callId ?? nextId()),
            callId: typeof t.callId === "string" ? t.callId : undefined,
            tool: typeof t.tool === "string" ? t.tool : "unknown",
            input: t.input && typeof t.input === "object" ? t.input : {},
            output: running
              ? "Interrupted by page reload before this tool completed."
              : typeof t.output === "string"
                ? t.output.slice(0, 6000)
                : "",
            status: running ? "failed" : t.status === "done" ? "done" : "failed",
          };
        }),
    });
  }
  if (maxId >= idCounter) idCounter = maxId + 1;
  return clean;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return [];
    return sanitizeMessages(JSON.parse(raw));
  } catch {
    return [];
  }
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function chatTitle(messages) {
  const first = messages.find((m) => m.role === "user");
  const text = String(first?.content || "Untitled chat").replace(/\s+/g, " ").trim();
  return text.length > 42 ? text.slice(0, 42) + "…" : text || "Untitled chat";
}

// Tab lifecycle: a reload keeps the same sessionStorage, a closed+reopened
// tab does not. Refresh → resume draft. New tab → archive a non-empty draft
// as a past chat and start fresh. Idempotent (archive clears the draft), so
// double-invocation is safe.
function initChat() {
  let tabAlive = false;
  try {
    tabAlive = !!sessionStorage.getItem(SESSION_FLAG);
  } catch {
    tabAlive = true; // storage blocked: never archive, never lose text
  }
  let draft = loadHistory();
  if (draft.length === 0) {
    const legacy = readJSON(LEGACY_KEY);
    if (legacy.length) {
      draft = sanitizeMessages(legacy);
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        localStorage.removeItem(LEGACY_KEY);
      } catch { /* ignore */ }
    }
  }
  if (!tabAlive && draft.length > 0) {
    const archive = readJSON(ARCHIVE_KEY);
    archive.unshift({ id: Date.now(), title: chatTitle(draft), at: Date.now(), messages: draft });
    try {
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive.slice(0, MAX_ARCHIVED_CHATS)));
      localStorage.removeItem(DRAFT_KEY);
    } catch { /* ignore */ }
    draft = [];
  }
  try {
    sessionStorage.setItem(SESSION_FLAG, "1");
  } catch { /* ignore */ }
  return draft;
}

function loadArchive() {
  return readJSON(ARCHIVE_KEY).filter(
    (c) => c && typeof c === "object" && Array.isArray(c.messages),
  );
}

function historyContent(message) {
  if (!message.tools?.length) return message.content;
  const evidence = message.tools.map((run) => {
    const result = run.output || (run.status === "failed" ? "Tool failed." : "(empty result)");
    const compactResult = String(result).slice(0, MAX_TOOL_CONTEXT_CHARS);
    return `[Tool ${run.status}: ${run.tool}]\nInput: ${JSON.stringify(run.input || {})}\nResult: ${compactResult}`;
  });
  return [message.content, ...evidence].filter(Boolean).join("\n\n").slice(0, MAX_MESSAGE_CONTEXT_CHARS);
}

function buildHistory(messages) {
  const selected = [];
  let totalChars = 0;
  for (const message of [...messages].reverse()) {
    const content = historyContent(message).slice(0, MAX_MESSAGE_CONTEXT_CHARS);
    if (selected.length && totalChars + content.length > MAX_HISTORY_CHARS) continue;
    selected.push({ role: message.role, content });
    totalChars += content.length;
    if (selected.length >= MAX_HISTORY_MESSAGES) break;
  }
  return selected.reverse();
}

function eventText(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// Model citation artifacts (【...】) render as ugly literal text and carry no
// links, so strip them before display. Raw history sent to the model is kept.
function cleanDisplayText(value) {
  return String(value || "").replace(/【[^】]*】/g, "");
}

const mdComponents = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
  h1: ({ children }) => <h1 className="mb-2 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 text-sm font-semibold">{children}</h4>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-cyan-300 underline hover:text-cyan-200"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-slate-600 pl-3 text-slate-300">{children}</blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-slate-800 px-1 py-0.5 text-[13px] text-cyan-100">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded-xl border border-slate-700">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-slate-700 px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-slate-800 px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-3 border-slate-700" />,
};

function parseSseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`Invalid stream event: ${error.message}`);
  }
}

export default function App() {
  const [messages, setMessages] = useState(initChat);
  const [history, setHistory] = useState(loadArchive);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [backendState, setBackendState] = useState("checking"); // checking | online | waking
  const scrollRef = useRef(null);
  const toolCounter = useRef(0);

  // Persist the live draft in this browser so a refresh keeps the chat.
  // Best-effort: private mode or quota errors must never break the chat.
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
    } catch {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(messages.slice(-10)));
      } catch {
        /* ignore */
      }
    }
  }, [messages]);

  function saveArchive(list) {
    setHistory(list);
    try {
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list.slice(0, MAX_ARCHIVED_CHATS)));
    } catch { /* ignore */ }
  }

  function startNewChat() {
    setMessages((current) => {
      if (current.length > 0) {
        saveArchive([
          { id: Date.now(), title: chatTitle(current), at: Date.now(), messages: current },
          ...history,
        ]);
      }
      return [];
    });
    setShowHistory(false);
  }

  function openArchived(id) {
    const item = history.find((c) => c.id === id);
    if (!item) return;
    saveArchive(history.filter((c) => c.id !== id)); // move, not copy
    setMessages(sanitizeMessages(item.messages));
    setShowHistory(false);
  }

  function deleteArchived(id) {
    saveArchive(history.filter((c) => c.id !== id));
  }

  // Ping /health on load; banner if slower than 2s (Render free-tier cold start).
  useEffect(() => {
    let cancelled = false;
    const slowTimer = setTimeout(() => {
      if (!cancelled) setBackendState((s) => (s === "online" ? s : "waking"));
    }, 2000);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${API}/health`);
        if (!cancelled && r.ok) {
          clearTimeout(slowTimer);
          setBackendState("online");
          clearInterval(poll);
        }
      } catch {
        if (!cancelled) setBackendState("waking");
      }
    }, 5000);
    (async () => {
      try {
        const r = await fetch(`${API}/health`);
        if (!cancelled && r.ok) {
          clearTimeout(slowTimer);
          setBackendState("online");
          clearInterval(poll);
        }
      } catch {
        if (!cancelled) setBackendState("waking");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function sendMessage(text) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const userMsg = { id: nextId(), role: "user", content, tools: [] };
    const assistantId = nextId();
    const history = buildHistory([...messages, userMsg]);
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", tools: [] },
    ]);
    setInput("");
    setLoading(true);

    const patchAssistant = (fn) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? fn(m) : m)),
      );

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFinished = false;
      const activeCalls = new Set();
      const handleEvent = (ev) => {
        if (ev === null) return;
        if (!ev || typeof ev.type !== "string") {
          throw new Error("Stream event is missing a type");
        }
        if (ev.type === "tool_start") {
          const callId = ev.call_id || `${ev.tool}-${++toolCounter.current}`;
          activeCalls.add(callId);
          patchAssistant((m) => ({
            ...m,
            tools: [
              ...m.tools,
              { key: callId, callId, tool: ev.tool, input: ev.input || {}, output: null, status: "running" },
            ],
          }));
        } else if (ev.type === "tool_end" || ev.type === "tool_error") {
          const failed = ev.type === "tool_error" || ev.status === "failed" || Boolean(ev.error);
          patchAssistant((m) => {
            const tools = [...m.tools];
            let index = ev.call_id
              ? tools.findIndex((run) => run.callId === ev.call_id)
              : -1;
            if (index < 0) {
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].tool === ev.tool && tools[i].status === "running") {
                  index = i;
                  break;
                }
              }
            }
            const output = eventText(ev.error ?? ev.output);
            if (index >= 0) {
              tools[index] = { ...tools[index], output, status: failed ? "failed" : "done" };
            }
            // Orphan completion with no matching start: ignore rather than
            // inventing a tool pill for work the UI never showed starting.
            return { ...m, tools };
          });
          if (ev.call_id) activeCalls.delete(ev.call_id);
          else {
            const fallbackCall = [...activeCalls].reverse().find((callId) => callId.startsWith(`${ev.tool}-`));
            if (fallbackCall) activeCalls.delete(fallbackCall);
          }
        } else if (ev.type === "token") {
          const chunk = ev.content || "";
          patchAssistant((m) => ({ ...m, content: m.content + chunk }));
        } else if (ev.type === "error") {
          throw new Error(ev.message || ev.error || "Agent stream failed");
        } else if (ev.type === "done") {
          if (activeCalls.size) {
            throw new Error("Response ended while a tool was still running");
          }
          streamFinished = true;
          setLoading(false);
        } else {
          // Ignore unknown future event types so new backend events degrade
          // gracefully instead of killing the whole in-progress answer.
          return;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() || "";
        for (const frame of frames) {
          handleEvent(parseSseFrame(frame));
        }
      }
      if (buffer.trim()) handleEvent(parseSseFrame(buffer));
      if (!streamFinished) throw new Error("Response stream ended before the done event");
    } catch (e) {
      patchAssistant((m) => ({
        ...m,
        tools: m.tools.map((run) => run.status === "running" ? { ...run, status: "failed", output: "The response stream ended before this tool completed." } : run),
        content: `${m.content}${m.content ? "\n\n" : ""}Error: ${e.message}`,
      }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1">
        {/* History sidebar */}
        <aside
          className={
            showHistory
              ? "fixed inset-y-0 left-0 z-20 flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950 py-6 pl-4 pr-3"
              : "hidden w-72 shrink-0 flex-col border-r border-slate-800 py-6 pl-4 pr-3 md:flex"
          }
        >
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={startNewChat}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-4 py-2.5 text-sm font-medium text-slate-950"
            >
              <Plus size={16} /> New chat
            </button>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              aria-label="Close history"
              className="rounded-xl border border-slate-700 p-2.5 text-slate-300 md:hidden"
            >
              <X size={16} />
            </button>
          </div>
          <p className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-widest text-slate-500">
            <History size={13} /> Past chats
          </p>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {history.length === 0 && (
              <p className="px-1 text-xs text-slate-500">
                Closed-tab chats will appear here.
              </p>
            )}
            {history.map((c) => (
              <div
                key={c.id}
                className="group flex items-center gap-1 rounded-xl px-2 py-2 hover:bg-slate-800/60"
              >
                <button
                  type="button"
                  onClick={() => openArchived(c.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm text-slate-200">{c.title}</p>
                  <p className="text-[11px] text-slate-500">
                    {c.at ? new Date(c.at).toLocaleString() : ""}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => deleteArchived(c.id)}
                  aria-label={`Delete ${c.title}`}
                  className="shrink-0 rounded p-1 text-slate-500 opacity-0 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </aside>
        {showHistory && (
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setShowHistory(false)}
            className="fixed inset-0 z-10 bg-black/50 md:hidden"
          />
        )}
      <section className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 py-6">
        <header className="mb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-label="Toggle chat history"
            className="rounded-xl border border-slate-700 p-2.5 text-slate-300 md:hidden"
          >
            <History size={18} />
          </button>
          <div className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-300">
            <Bot size={24} />
          </div>
          <div className="flex-1">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-cyan-300">
              OmniAgent
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Your research copilot
            </h1>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs ${
              backendState === "online"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-amber-500/15 text-amber-300"
            }`}
          >
            {backendState === "online" ? "● Backend online" : "● Connecting…"}
          </span>
        </header>

        {backendState === "waking" && (
          <div className="mb-4 rounded-2xl border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            Waking up backend server (Render free tier), please allow up to 50
            seconds.
          </div>
        )}

        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="mb-4 min-h-0 flex-1 space-y-4 overflow-y-auto rounded-3xl border border-slate-800 bg-slate-900/50 p-4"
        >
          {messages.length === 0 && (
            <div className="text-sm text-slate-400">
              <p className="mb-3">
                Ask about inventory, store policies, or the web. I’ll show
                which tool I use.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={loading}
                    onClick={() => sendMessage(s)}
                    aria-label={`Ask: ${s}`}
                    className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-600 disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {m.role === "assistant" && (
                <Bot size={18} className="mt-1 shrink-0 text-cyan-300" />
              )}
              <div
                className={`max-w-[85%] rounded-2xl border px-4 py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "border-cyan-800 bg-cyan-500/10"
                    : "border-slate-700 bg-slate-900"
                }`}
              >
                {m.role === "assistant" &&
                  m.tools.map((t) => <ToolPill key={t.key} run={t} />)}
                {m.role === "assistant" ? (
                  <div className="text-sm leading-relaxed">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={mdComponents}
                      urlTransform={(url) =>
                        /^(https?:|mailto:)/i.test(url || "") ? url : "#"
                      }
                    >
                      {cleanDisplayText(m.content)}
                    </ReactMarkdown>
                    {loading && !m.content && (
                      <Loader2 size={16} className="animate-spin text-slate-400" />
                    )}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                )}
              </div>
              {m.role === "user" && (
                <User size={18} className="mt-1 shrink-0 text-slate-400" />
              )}
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="flex gap-2"
        >
          <input
            aria-label="Message"
            maxLength={8000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about stock, policies, or anything current…"
            className="flex-1 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-cyan-600"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label={loading ? "Waiting for response" : "Send message"}
            className="flex items-center gap-2 rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-medium text-slate-950 disabled:opacity-40"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Send
          </button>
        </form>
        <p className="mt-2 text-center text-xs text-slate-500">
          Tools: web search · policy docs · read-only SQL · live quotes
          <br />
          History is kept in this browser — past chats live in the sidebar, only
          recent turns are sent to the model.
        </p>
      </section>
      </div>
    </main>
  );
}
