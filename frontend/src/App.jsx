import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  User,
  Wrench,
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
const MAX_HISTORY_MESSAGES = 16;
const MAX_HISTORY_CHARS = 24_000;
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
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [backendState, setBackendState] = useState("checking"); // checking | online | waking
  const scrollRef = useRef(null);
  const toolCounter = useRef(0);

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
            } else {
              const callId = ev.call_id || `${ev.tool || "unknown"}-${++toolCounter.current}`;
              tools.push({ key: callId, callId, tool: ev.tool || "unknown", input: ev.input || {}, output, status: failed ? "failed" : "done" });
            }
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
          throw new Error(`Unsupported stream event type: ${ev.type}`);
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
    <main className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
        <header className="mb-4 flex items-center gap-3">
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
          className="mb-4 max-h-[60vh] flex-1 space-y-4 overflow-y-auto rounded-3xl border border-slate-800 bg-slate-900/50 p-4"
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
                    onClick={() => sendMessage(s)}
                    aria-label={`Ask: ${s}`}
                    className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-600"
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
                <div className="whitespace-pre-wrap">
                  {m.content}
                  {m.role === "assistant" && loading && !m.content && (
                    <Loader2 size={16} className="animate-spin text-slate-400" />
                  )}
                </div>
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
          Tools: web search · policy docs · read-only SQL
        </p>
      </section>
    </main>
  );
}
