"use client";

import { useState } from "react";

type RunResponse = unknown;

export default function Home() {
  const [queueSize, setQueueSize] = useState("100");
  const [rate, setRate] = useState("5Mbps");
  const [k, setK] = useState("4");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);

  async function runSimulation() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          queueSize: Number(queueSize),
          rate,
          k: Number(k),
        }),
      });

      if (!res.ok) {
        throw new Error(`Backend Error: ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-10">
        <header className="mb-8 flex items-start justify-between gap-6">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-400">
              ns-3 visualization
            </p>
          </div>

          <div className="w-full max-w-xl rounded-2xl p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={queueSize}
                onChange={(event) => setQueueSize(event.target.value)}
                className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder="Queue size"
              />

              <input
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder="Sending rate"
              />

              <input
                value={k}
                onChange={(event) => setK(event.target.value)}
                className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500 md:col-span-2"
                placeholder="k"
              />
            </div>

            <div className="mt-3 flex justify-end">
              <button
                onClick={runSimulation}
                disabled={loading}
                className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-60"
              >
                {loading ? "Running..." : "Run"}
              </button>
            </div>

            {error ? (
              <p className="mt-3 text-sm text-rose-400">{error}</p>
            ) : null}

            {result ? (
              <pre className="mt-3 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-200">
                {JSON.stringify(result, null, 2)}
              </pre>
            ) : null}
          </div>
        </header>
      </div>
    </main>
  );
}