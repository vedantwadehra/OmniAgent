import { Bot, Sparkles } from "lucide-react";

export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <section className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <div className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-300">
            <Bot size={24} />
          </div>
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.25em] text-cyan-300">OmniAgent</p>
            <h1 className="text-3xl font-semibold tracking-tight">Your research copilot</h1>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-cyan-950/20">
          <div className="flex items-start gap-4">
            <Sparkles className="mt-1 shrink-0 text-amber-300" size={20} />
            <div>
              <h2 className="text-lg font-medium">Phase 1 is ready</h2>
              <p className="mt-2 text-slate-400">
                The chat surface will connect to the FastAPI agent in the next phase.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

