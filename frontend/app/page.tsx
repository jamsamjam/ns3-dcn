"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type TraceEventType = "QUEUE_LEN_CHANGE" | "SOJOURN_TIME" | "PACKET_DROP";

type TraceEvent = {
  time: number;
  type: TraceEventType;
  linkId?: string;
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

type TraceLink = {
  linkId: string;
  fro: number;
  to: number;
  rate: string;
  delay: string;
  label?: string;
};

type TraceData = {
  topology?: string;
  queueSize?: string;
  sendingRate?: string;
  simTime?: number;
  links?: TraceLink[];
  events?: TraceEvent[];
  metrics?: TraceMetrics;
};

type QueuePoint = {
  time: number;
  packets: number;
  raw: TraceEvent;
};

type PacketMotion = {
  id: string;
  linkId: string;
  position: number;
  kind: "send" | "drain" | "drop";
};

function parseTrace(content: string): TraceData {
  const parsed = JSON.parse(content) as TraceData;
  if (!parsed || !Array.isArray(parsed.events)) {
    throw new Error("Invalid trace format: events array is missing.");
  }
  return parsed;
}

function parsePacketCount(value?: string): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(/(\d+)/); // \d+ one or more 0-9
  if (!match) {
    return null;
  }
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatMs(value?: number): string {
  if (value == null) {
    return "-";
  }
  return `${value.toFixed(0)} ms`;
}

function buildPacketMotions(events: TraceEvent[], currentIndex: number): PacketMotion[] {
  const motions: PacketMotion[] = [];
  const windowStart = Math.max(0, currentIndex - 8);
  const recentEvents = events.slice(windowStart, currentIndex + 1);

  recentEvents.forEach((event, offset) => {
    const freshness = (offset + 1) / (recentEvents.length + 1);

    if (event.type === "QUEUE_LEN_CHANGE") {
      const delta = (event.newPackets ?? 0) - (event.oldPackets ?? 0);

      if (delta > 0) {
        motions.push({
          id: `in-${windowStart + offset}-${event.time}`,
          linkId: "n0-n1",
          position: clamp(20 + freshness * 55, 0, 100),
          kind: "send",
        });
      }

      if (delta < 0) {
        motions.push({
          id: `out-${windowStart + offset}-${event.time}`,
          linkId: "n1-n2",
          position: clamp(20 + freshness * 55, 0, 100),
          kind: "drain",
        });
      }
    }

    if (event.type === "PACKET_DROP") {
      motions.push({
        id: `drop-${windowStart + offset}-${event.time}`,
        linkId: "drop",
        position: 8,
        kind: "drop",
      });
    }
  });

  return motions.slice(-14);
}

function summarizeEvent(event: TraceEvent): string {
  if (event.type === "QUEUE_LEN_CHANGE") {
    return `${event.oldPackets ?? 0} → ${event.newPackets ?? 0}`;
  }
  if (event.type === "SOJOURN_TIME") {
    return `${event.delayMs ?? 0} ms queueing delay`;
  }
  if (event.type === "PACKET_DROP") {
    return `packet ${event.packetId ?? "?"} dropped (${event.size ?? "?"} B)`;
  }
  return event.type;
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState("/simple.json");
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);

  const allEvents = trace?.events ?? [];

  const queueEvents = useMemo<QueuePoint[]>(() => {
    return allEvents
      .filter((event) => event.type === "QUEUE_LEN_CHANGE")
      .map((event) => ({
        time: event.time,
        packets: event.newPackets ?? 0,
        raw: event,
      }));
  }, [allEvents]);

  const sojournEvents = useMemo(() => {
    return allEvents.filter((event) => event.type === "SOJOURN_TIME");
  }, [allEvents]);

  const dropEvents = useMemo(() => {
    return allEvents.filter((event) => event.type === "PACKET_DROP");
  }, [allEvents]);

  const queueCapacity = useMemo(() => {
    const parsed = parsePacketCount(trace?.queueSize);
    return parsed ?? Math.max(...queueEvents.map((event) => event.packets), 1);
  }, [trace?.queueSize, queueEvents]);

  const fastLink = useMemo(() => trace?.links?.find((l) => l.label === "fast"), [trace]);
  const bottleneckLink = useMemo(() => trace?.links?.find((l) => l.label === "bottleneck"), [trace]);

  const boundedPlayIndex = Math.min(playIndex, Math.max(queueEvents.length - 1, 0));
  const activeQueuePoint = queueEvents[boundedPlayIndex] ?? null;
  const activeRawEvent = activeQueuePoint?.raw ?? null;
  const activePackets = activeQueuePoint?.packets ?? 0;
  const queueUtilization = clamp((activePackets / Math.max(queueCapacity, 1)) * 100, 0, 100);
  const currentTime = activeQueuePoint?.time ?? 0;

  const nearestSojourn = useMemo(() => {
    if (!sojournEvents.length || !activeQueuePoint) {
      return null;
    }

    let best = sojournEvents[0];
    let bestDiff = Math.abs(sojournEvents[0].time - activeQueuePoint.time);

    for (const event of sojournEvents) {
      const diff = Math.abs(event.time - activeQueuePoint.time);
      if (diff < bestDiff) {
        best = event;
        bestDiff = diff;
      }
    }

    return best;
  }, [sojournEvents, activeQueuePoint]);

  const recentDrop = useMemo(() => {
    if (!dropEvents.length || !activeQueuePoint) {
      return null;
    }

    const visibleDrops = dropEvents.filter((event) => event.time <= activeQueuePoint.time);
    if (!visibleDrops.length) {
      return null;
    }
    return visibleDrops[visibleDrops.length - 1];
  }, [dropEvents, activeQueuePoint]);

  const packetMotions = useMemo(() => {
    return buildPacketMotions(
      queueEvents.map((event) => event.raw),
      boundedPlayIndex
    );
  }, [queueEvents, boundedPlayIndex]);

  const recentEvents = useMemo(() => {
    if (!activeQueuePoint) {
      return allEvents.slice(-12);
    }
    return allEvents.filter((event) => event.time <= activeQueuePoint.time).slice(-12);
  }, [allEvents, activeQueuePoint]);

  const queueTrend = useMemo(() => {
    if (!queueEvents.length) {
      return [] as QueuePoint[];
    }
    return queueEvents.filter((event) => event.time <= currentTime).slice(-30);
  }, [queueEvents, currentTime]);

  const peakQueue = trace?.metrics?.maxQueueSize ?? Math.max(...queueEvents.map((event) => event.packets), 0);
  const avgSojourn = trace?.metrics?.avgSojournTime ?? 0;
  const packetsLost = trace?.metrics?.packetsLost ?? dropEvents.length;
  const dropIsActive = Boolean(recentDrop && currentTime - recentDrop.time < 0.4);

  useEffect(() => {
    if (!isPlaying || queueEvents.length === 0) {
      return;
    }

    const timer = window.setInterval(function () {
      setPlayIndex(function (prev) {
        if (prev >= queueEvents.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 90);

    return function cleanup() {
      window.clearInterval(timer);
    };
  }, [isPlaying, queueEvents.length]);

  useEffect(() => {
    setPlayIndex(0);
    setIsPlaying(false);
  }, [trace]);

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
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto max-w-6xl px-6 py-10 md:px-10">
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-400">ns-3 visualization</p>
          </div>

          <div className="rounded-2xl p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <input
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                className="h-11 min-w-[220px] rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder="/simple.json"
              />
              <button
                onClick={loadFromUrl}
                disabled={loading}
                className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-60"
              >
                {loading ? "Loading..." : "Load"}
              </button>
              <label className="flex h-11 cursor-pointer items-center rounded-xl border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800">
                Upload
                <input type="file" accept=".json,application/json" onChange={onFileChange} className="hidden" />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
          </div>
        </header>

        {!trace ? (
          <section>
            Load a trace to start the visualization.
          </section>
        ) : (
          <div className="space-y-6">
            <section>
              <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => {
                      if (!queueEvents.length) {
                        return;
                      }
                      setIsPlaying((prev) => !prev);
                    }}
                    className="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white"
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    onClick={() => {
                      setIsPlaying(false);
                      setPlayIndex(0);
                    }}
                    className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    Reset
                  </button>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 p-6">
                <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_1.2fr_1fr] md:items-center">
                  <div className="rounded-3xl border border-white p-5 text-center">
                    <p className="mt-3 text-xl font-semibold">Sender (n0)</p>
                    <p className="mt-2 text-sm text-zinc-300">
                      {fastLink ? `${fastLink.rate} / ${fastLink.delay}` : "-"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">app rate {trace.sendingRate ?? "-"}</p>
                  </div>

                  <div
                    className={`rounded-3xl border p-5 transition ${
                      dropIsActive ? "border-rose-500/70 bg-rose-950/20" : "border-amber-700/50 bg-amber-950/10"
                    }`}
                  >
                    <div className="text-center">
                      <p className="mt-3 text-xl font-semibold">Router (n1)</p>
                      <p className="mt-2 text-sm text-zinc-300">
                        {bottleneckLink ? `${bottleneckLink.rate} / ${bottleneckLink.delay}` : "-"}
                      </p>
                    </div>

                    <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                      <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
                        <span>occupancy</span>
                        <span>{activePackets} / {queueCapacity}</span>
                      </div>
                      <div className="h-4 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={`h-full rounded-full transition-all duration-100 ${
                            queueUtilization > 95
                              ? "bg-rose-500"
                              : queueUtilization > 75
                                ? "bg-amber-400"
                                : "bg-emerald-400"
                          }`}
                          style={{ width: `${queueUtilization}%` }}
                        />
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-xl bg-zinc-900 p-2">
                          <p className="text-zinc-500">change</p>
                          <p className="mt-1 font-medium text-zinc-100">
                            {activeRawEvent ? `${activeRawEvent.oldPackets ?? 0} → ${activeRawEvent.newPackets ?? 0}` : "-"}
                          </p>
                        </div>
                        <div className="rounded-xl bg-zinc-900 p-2">
                          <p className="text-zinc-500">delay</p>
                          <p className="mt-1 font-medium text-zinc-100">{formatMs(nearestSojourn?.delayMs)}</p>
                        </div>
                        <div className="rounded-xl bg-zinc-900 p-2">
                          <p className="text-zinc-500">drop</p>
                          <p className="mt-1 font-medium text-zinc-100">{dropIsActive ? "yes" : "no"}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white p-5 text-center">
                    <p className="mt-3 text-xl font-semibold">Server (n2)</p>
                    <p className="mt-2 text-sm text-zinc-300">receives drained packets</p>
                    <p className="mt-1 text-xs text-zinc-500">sojourn {formatMs(nearestSojourn?.delayMs)}</p>
                  </div>
                </div>

                <div className="pointer-events-none absolute left-[14%] right-[14%] top-1/2 hidden -translate-y-1/2 md:block">
                  <div className="relative h-24">
                    <div className="absolute left-[7%] right-[52%] top-1/2 h-[2px] -translate-y-1/2 bg-zinc-700" />
                    <div className="absolute left-[52%] right-[7%] top-1/2 h-[2px] -translate-y-1/2 bg-zinc-700" />

                    {packetMotions.map((motion) => {
                      const baseClasses =
                        motion.kind === "drop"
                          ? "bg-rose-500 shadow-[0_0_18px_rgba(244,63,94,0.8)]"
                          : motion.kind === "drain"
                            ? "bg-emerald-400 shadow-[0_0_18px_rgba(74,222,128,0.6)]"
                            : "bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.6)]";

                      const style =
                        motion.linkId === "n0-n1"
                          ? { left: `${motion.position}%`, top: "33%" }
                          : motion.linkId === "n1-n2"
                            ? { left: `${50 + motion.position / 2}%`, top: "66%" }
                            : { left: "50%", top: "10%" }; // drop bubble above router

                      return (
                        <div
                          key={motion.id}
                          className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${baseClasses}`}
                          style={style}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>{currentTime.toFixed(3)}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(queueEvents.length - 1, 0)}
                  step={1}
                  value={boundedPlayIndex}
                  onChange={(event) => {
                    setIsPlaying(false);
                    setPlayIndex(Number.parseInt(event.target.value, 10));
                  }}
                  className="w-full accent-zinc-100"
                  disabled={queueEvents.length === 0}
                />
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <article>
                <div className="mb-4 flex items-center justify-between">
                  <p className="text-xs text-zinc-500">last {queueTrend.length} queue events</p>
                </div>

                {queueTrend.length === 0 ? (
                  <p className="text-sm text-zinc-500">No queue events yet.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex h-44 items-end gap-[2px] rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
                      {queueTrend.map((event, index) => {
                        const height = `${Math.max((event.packets / Math.max(queueCapacity, 1)) * 100, 2)}%`;
                        const isActive = index === queueTrend.length - 1;
                        return (
                          <div
                            key={`${event.time}-${index}`}
                            className={`flex-1 rounded-t ${isActive ? "bg-zinc-100" : "bg-zinc-600"}`}
                            style={{ height }}
                            title={`${event.time.toFixed(3)}s, ${event.packets} packets`}
                          />
                        );
                      })}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl bg-zinc-950/70 p-4">
                        <p className="text-xs tracking-[0.2em] text-zinc-500">Current queue</p>
                        <p className="mt-2 text-lg font-semibold">{activePackets}</p>
                      </div>
                      <div className="rounded-2xl bg-zinc-950/70 p-4">
                        <p className="text-xs tracking-[0.2em] text-zinc-500">Current sojourn</p>
                        <p className="mt-2 text-lg font-semibold">{nearestSojourn?.delayMs?.toFixed(0) ?? "-"}</p>
                      </div>
                      <div className="rounded-2xl bg-zinc-950/70 p-4">
                        <p className="text-xs tracking-[0.2em] text-zinc-500">Recent drop</p>
                        <p className="mt-2 text-lg font-semibold">{recentDrop ? recentDrop.packetId ?? "yes" : "-"}</p>
                      </div>
                    </div>
                  </div>
                )}
              </article>

              <article>
                <div className="mt-4 max-h-70 space-y-2 overflow-y-hidden pr-1">
                  {recentEvents.length === 0 ? (
                    <p className="text-sm text-zinc-500">No events visible.</p>
                  ) : (
                    recentEvents.map((event, index) => {
                      return (
                        <div
                          key={`${event.type}-${event.time}-${index}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-normal text-zinc-100">{event.type}</p>
                            <p className="font-mono text-xs text-zinc-500">{event.time.toFixed(4)}s</p>
                          </div>
                          <p className="mt-1 text-sm text-zinc-400">{summarizeEvent(event)}</p>
                        </div>
                      );
                    })
                  )}
                </div>
              </article>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}