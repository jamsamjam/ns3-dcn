"use client";

import { ChangeEvent, useMemo, useState } from "react";

type TraceEvent = {
  time: number;
  type: string;
  linkId?: number;
  oldPackets?: number;
  newPackets?: number;
  delayMs?: number;
  packetId?: number;
  size?: number;
};

type TraceMetrics = {
  maxQueueSize?: number;
  packetsLost?: number;
  packetsQueued?: number;
  avgSojournTime?: number;
};

type TraceData = {
  topology?: string;
  queueSize?: string;
  sendingRate?: string;
  simTime?: number;
  linkRate_fast?: string;
  linkRate_bottleneck?: string;
  events?: TraceEvent[];
  metrics?: TraceMetrics;
};

function parseTrace(content: string): TraceData {
  const parsed = JSON.parse(content) as TraceData;
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error("Invalid trace format: events array is missing.");
  }
  return parsed;
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState("/ns3-queue-trace.json");
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const queueEvents = useMemo(
    () =>
      (trace?.events ?? [])
        .filter((event) => event.type === "QUEUE_LEN_CHANGE")
        .map((event) => ({ time: event.time, packets: event.newPackets ?? 0 })),
    [trace]
  );

  const maxPackets = useMemo(
    () => Math.max(...queueEvents.map((event) => event.packets), 1),
    [queueEvents]
  );

  const sojournSamples = useMemo(
    () => (trace?.events ?? []).filter((event) => event.type === "SOJOURN_TIME").length,
    [trace]
  );

  async function loadFromUrl() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(sourceUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Could not fetch JSON from ${sourceUrl}`);
      }
      const text = await response.text();
      setTrace(parseTrace(text));
    } catch (err) {
      setTrace(null);
      setError(err instanceof Error ? err.message : "Unknown error while loading trace.");
    } finally {
      setLoading(false);
    }
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const text = await file.text();
      setTrace(parseTrace(text));
    } catch (err) {
      setTrace(null);
      setError(err instanceof Error ? err.message : "Invalid JSON file.");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-6 py-10 md:px-10">
      <section className="mb-8 space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">ns3</h1>
      </section>

      <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <input
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            className="h-10 flex-1 rounded-lg border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-500"
            placeholder="/ns3-queue-trace.json"
          />
          <button
            onClick={loadFromUrl}
            disabled={loading}
            className="h-10 rounded-lg border border-zinc-900 px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-900 hover:text-white disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load URL"}
          </button>
          <label className="h-10 cursor-pointer rounded-lg border border-zinc-300 px-4 text-sm font-medium leading-10 text-zinc-700 hover:bg-zinc-100">
            Upload .json
            <input type="file" accept=".json,application/json" onChange={onFileChange} className="hidden" />
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </section>

      {!trace ? (
        <section className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
          No data loaded yet.
        </section>
      ) : (
        <section className="space-y-6">
          <div className="grid gap-3 md:grid-cols-4">
            <article className="rounded-xl border border-zinc-200 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Queue Max</p>
              <p className="mt-1 text-2xl font-semibold">{trace.metrics?.maxQueueSize ?? 0}</p>
            </article>
            <article className="rounded-xl border border-zinc-200 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Packets Lost</p>
              <p className="mt-1 text-2xl font-semibold">{trace.metrics?.packetsLost ?? 0}</p>
            </article>
            <article className="rounded-xl border border-zinc-200 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Avg Sojourn (ms)</p>
              <p className="mt-1 text-2xl font-semibold">
                {(trace.metrics?.avgSojournTime ?? 0).toFixed(2)}
              </p>
            </article>
            <article className="rounded-xl border border-zinc-200 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Sojourn Samples</p>
              <p className="mt-1 text-2xl font-semibold">{sojournSamples}</p>
            </article>
          </div>

          <article className="rounded-xl border border-zinc-200 p-4">
            <h2 className="text-sm font-semibold text-zinc-800">Queue Length Timeline</h2>
            <div className="mt-4 space-y-2">
              {queueEvents.length === 0 ? (
                <p className="text-sm text-zinc-500">No QUEUE_LEN_CHANGE events found.</p>
              ) : (
                queueEvents.slice(-20).map((event, index) => (
                  <div key={`${event.time}-${index}`} className="grid grid-cols-[64px_1fr_48px] items-center gap-3 text-xs">
                    <span className="font-mono text-zinc-500">{event.time.toFixed(2)}s</span>
                    <div className="h-2 rounded bg-zinc-100">
                      <div
                        className="h-2 rounded bg-zinc-700"
                        style={{ width: `${(event.packets / maxPackets) * 100}%` }}
                      />
                    </div>
                    <span className="text-right font-mono">{event.packets}</span>
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="rounded-xl border border-zinc-200 p-4">
            <h2 className="text-sm font-semibold text-zinc-800">Recent Events</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-zinc-500">
                    <th className="py-2">time</th>
                    <th className="py-2">type</th>
                    <th className="py-2">old</th>
                    <th className="py-2">new</th>
                    <th className="py-2">delayMs</th>
                    <th className="py-2">packetId</th>
                  </tr>
                </thead>
                <tbody>
                  {(trace.events ?? []).slice(-25).map((event, index) => (
                    <tr key={`${event.time}-${event.type}-${index}`} className="border-b border-zinc-100">
                      <td className="py-2 font-mono">{event.time.toFixed(3)}</td>
                      <td className="py-2">{event.type}</td>
                      <td className="py-2">{event.oldPackets ?? "-"}</td>
                      <td className="py-2">{event.newPackets ?? "-"}</td>
                      <td className="py-2">{event.delayMs ?? "-"}</td>
                      <td className="py-2">{event.packetId ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      )}
    </main>
  );
}
