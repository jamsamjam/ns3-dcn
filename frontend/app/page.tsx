"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type QueueLenChange = {
  time: number;
  oldPackets?: number;
  newPackets?: number;
};

type SojournSample = {
  time: number;
  delayMs?: number;
};

type PacketDrop = {
  time: number;
  packetId?: number;
  size?: number;
};

type PacketDequeue = {
  time: number;
  packetId?: number;
  size?: number;
};

type TraceMetrics = {
  maxQueueSize?: number;
  packetsLost?: number;
  packetsQueued?: number;
  avgSojournTime?: number;
};

type LinkTrace = {
  queueLenChanges?: QueueLenChange[];
  sojournSamples?: SojournSample[];
  packetDrops?: PacketDrop[];
  packetDequeues?: PacketDequeue[];
  metrics?: TraceMetrics;
};

type TraceLink = {
  linkId: string;
  from: number;
  to: number;
  rate: string;
  delay: string;
  label?: string;
  trace?: LinkTrace;
};

type TraceData = {
  topology?: string;
  queueSize?: string;
  sendingRate?: string;
  simTime?: number;
  links?: TraceLink[];
};

type TimelineEvent =
  | ({ type: "QUEUE_LEN_CHANGE"; linkId: string } & QueueLenChange)
  | ({ type: "SOJOURN_TIME"; linkId: string } & SojournSample)
  | ({ type: "PACKET_DROP"; linkId: string } & PacketDrop)
  | ({ type: "PACKET_DEQUEUE"; linkId: string } & PacketDequeue);

type QueuePoint = {
  time: number;
  packets: number;
  raw: TimelineEvent;
};

type PacketMotion = {
  id: string;
  linkId: string;
  position: number;
  kind: "send" | "drain" | "drop";
};

function parseTrace(content: string): TraceData {
  const parsed = JSON.parse(content) as TraceData;
  if (!parsed || !Array.isArray(parsed.links)) {
    throw new Error("Invalid trace format: links array is missing.");
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

function flattenTimeline(links: TraceLink[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const link of links) {
    const trace = link.trace;

    for (const event of trace?.queueLenChanges ?? []) {
      events.push({
        type: "QUEUE_LEN_CHANGE",
        linkId: link.linkId,
        ...event,
      });
    }

    for (const event of trace?.sojournSamples ?? []) {
      events.push({
        type: "SOJOURN_TIME",
        linkId: link.linkId,
        ...event,
      });
    }

    for (const event of trace?.packetDrops ?? []) {
      events.push({
        type: "PACKET_DROP",
        linkId: link.linkId,
        ...event,
      });
    }

    for (const event of trace?.packetDequeues ?? []) {
      events.push({
        type: "PACKET_DEQUEUE",
        linkId: link.linkId,
        ...event,
      });
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

function buildPacketMotions(
  queueEvents: QueuePoint[],
  dequeueEvents: PacketDequeue[],
  currentIndex: number,
  fastLinkId: string,
  bottleneckLinkId: string
): PacketMotion[] {
  const motions: PacketMotion[] = [];
  const activeQueueTime = queueEvents[currentIndex]?.time ?? 0;

  const recentQueueEvents = queueEvents
    .filter((event) => event.time <= activeQueueTime)
    .slice(-10);

  recentQueueEvents.forEach((event, index) => {
    const freshness = (index + 1) / Math.max(recentQueueEvents.length, 1);
    const delta = (event.raw.newPackets ?? 0) - (event.raw.oldPackets ?? 0);

    if (delta > 0) {
      motions.push({
        id: `send-${event.time}-${index}`,
        linkId: fastLinkId,
        position: 5 + freshness * 90,
        kind: "send",
      });
    }
  });

  const recentDequeues = dequeueEvents
    .filter((event) => event.time <= activeQueueTime)
    .slice(-8);

  recentDequeues.forEach((event, index) => {
    const freshness = (index + 1) / Math.max(recentDequeues.length, 1);
    motions.push({
      id: `deq-${event.packetId ?? index}-${event.time}`,
      linkId: bottleneckLinkId,
      position: 5 + freshness * 90,
      kind: "drain",
    });
  });

  return motions.slice(-18);
}

function summarizeEvent(event: TimelineEvent): string {
  if (event.type === "QUEUE_LEN_CHANGE") {
    return `[${event.linkId}] ${event.oldPackets ?? 0} -> ${event.newPackets ?? 0}`;
  }
  if (event.type === "SOJOURN_TIME") {
    return `[${event.linkId}] ${event.delayMs ?? 0} ms queueing delay`;
  }
  if (event.type === "PACKET_DROP") {
    return `[${event.linkId}] packet ${event.packetId ?? "?"} dropped (${event.size ?? "?"} B)`;
  }
  if (event.type === "PACKET_DEQUEUE") {
    return `[${event.linkId}] packet ${event.packetId ?? "?"} dequeued (${event.size ?? "?"} B)`;
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

  const links = trace?.links ?? [];
  const allEvents = useMemo(() => flattenTimeline(links), [links]);

  const fastLink = useMemo(() => links.find((l) => l.label === "fast") ?? links[0] ?? null, [links]);
  const bottleneckLink = useMemo(() => links.find((l) => l.label === "bottleneck") ?? links[1] ?? null, [links]);

  const queueEvents = useMemo<QueuePoint[]>(() => {
    const source = bottleneckLink?.trace?.queueLenChanges ?? [];
    return source.map((event) => ({
      time: event.time,
      packets: event.newPackets ?? 0,
      raw: {
        type: "QUEUE_LEN_CHANGE" as const,
        linkId: bottleneckLink?.linkId ?? "unknown",
        ...event,
      },
    }));
  }, [bottleneckLink]);

  const sojournEvents = useMemo(() => bottleneckLink?.trace?.sojournSamples ?? [], [bottleneckLink]);
  const dropEvents = useMemo(() => bottleneckLink?.trace?.packetDrops ?? [], [bottleneckLink]);
  const dequeueEvents = useMemo(() => bottleneckLink?.trace?.packetDequeues ?? [], [bottleneckLink]);

  const queueCapacity = useMemo(() => {
    const parsed = parsePacketCount(trace?.queueSize);
    return parsed ?? Math.max(...queueEvents.map((event) => event.packets), 1);
  }, [trace?.queueSize, queueEvents]);

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
    if (!fastLink || !bottleneckLink) {
      return [];
    }

    return buildPacketMotions(
      queueEvents,
      dequeueEvents,
      boundedPlayIndex,
      fastLink.linkId,
      bottleneckLink.linkId
    );
  }, [queueEvents, dequeueEvents, dropEvents, boundedPlayIndex, fastLink, bottleneckLink]);

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

  const peakQueue =
    bottleneckLink?.trace?.metrics?.maxQueueSize ??
    Math.max(...queueEvents.map((event) => event.packets), 0);

  const avgSojourn = bottleneckLink?.trace?.metrics?.avgSojournTime ?? 0;
  const packetsLost = bottleneckLink?.trace?.metrics?.packetsLost ?? dropEvents.length;
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
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-10">
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
          <section>Load a trace to start the visualization.</section>
        ) : (
          <div className="space-y-6">
            <section>
              <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 p-6 md:p-8">
                <div className="absolute top-4 right-6 flex gap-4 z-10">
                  <button
                    onClick={() => {
                      if (!queueEvents.length) return;
                      setIsPlaying((prev) => !prev);
                    }}
                    className="text-xl text-zinc-300 hover:text-white transition"
                  >
                    {isPlaying ? "⏸" : "⏵"}
                  </button>

                  <button
                    onClick={() => {
                      setIsPlaying(false);
                      setPlayIndex(0);
                    }}
                    className="text-xl text-zinc-300 hover:text-white transition"
                  >
                    ⏹
                  </button>
                </div>

                <div className="relative hidden h-[320px] md:block">
                  <div className="absolute left-[6%] top-[49%] h-8 w-8 -translate-y-1/2 rounded-full border border-zinc-200 bg-zinc-900" />
                  <div className="absolute left-[47%] top-[49%] h-10 w-10 -translate-y-1/2 rounded-full border border-amber-500/70 bg-zinc-900" />
                  <div className="absolute right-[6%] top-[49%] h-8 w-8 -translate-y-1/2 rounded-full border border-zinc-200 bg-zinc-900" />

                  <div className="absolute left-[10%] right-[56%] top-[49%] h-[2px] -translate-y-1/2 bg-zinc-700" />
                  <div
                    className={`absolute left-[51%] right-[10%] top-[49%] h-[3px] -translate-y-1/2 transition-all duration-150 ${
                      dropIsActive
                        ? "bg-rose-500 shadow-[0_0_14px_rgba(244,63,94,0.9)] animate-pulse"
                        : "bg-zinc-700"
                    }`}
                  />
                  
                  <div className="absolute left-[6%] top-[61%] w-28 -translate-x-1/2 text-center">
                    <p className="text-sm font-semibold">n0</p>
                    <p className="mt-1 text-xs text-zinc-400">Sender</p>
                  </div>

                  <div className="absolute left-[47%] top-[61%] w-28 -translate-x-1/2 text-center">
                    <p className="text-sm font-semibold">n1</p>
                    <p className="mt-1 text-xs text-zinc-400">Router</p>
                  </div>

                  <div className="absolute right-[6%] top-[61%] w-28 translate-x-1/2 text-center">
                    <p className="text-sm font-semibold">n2</p>
                    <p className="mt-1 text-xs text-zinc-400">Server</p>
                  </div>

                  <div className="absolute left-[19%] top-[37%] -translate-x-1/2 text-center">
                    <p className="text-xs text-zinc-400">{fastLink ? `${fastLink.rate} / ${fastLink.delay}` : "-"}</p>
                  </div>

                  <div className="absolute left-[73%] top-[37%] -translate-x-1/2 text-center">
                    <p className="text-xs text-zinc-400">{bottleneckLink ? `${bottleneckLink.rate} / ${bottleneckLink.delay}` : "-"}</p>
                  </div>

                  {packetMotions.map((motion) => {
                    const baseClasses =
                      motion.kind === "drain"
                        ? "bg-emerald-400 shadow-[0_0_18px_rgba(74,222,128,0.6)]"
                        : "bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.6)]";

                    const style =
                      motion.linkId === fastLink?.linkId
                        ? { left: `${10 + motion.position * 0.37}%`, top: "49%" }
                        : { left: `${51 + motion.position * 0.39}%`, top: "49%" };

                    return (
                      <div
                        key={motion.id}
                        className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${baseClasses}`}
                        style={style}
                      />
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 gap-4 md:hidden">
                  <div className="rounded-2xl border border-zinc-800 p-4 text-center">
                    <p className="font-semibold">n0 → n1</p>
                    <p className="mt-1 text-sm text-zinc-400">{fastLink ? `${fastLink.rate} / ${fastLink.delay}` : "-"}</p>
                  </div>
                  <div className="rounded-2xl border border-zinc-800 p-4 text-center">
                    <p className="font-semibold">n1 → n2</p>
                    <p className="mt-1 text-sm text-zinc-400">{bottleneckLink ? `${bottleneckLink.rate} / ${bottleneckLink.delay}` : "-"}</p>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <p className="text-xs tracking-[0.2em] text-zinc-500">Current queue</p>
                    <p className="mt-2 text-lg font-semibold">{activePackets}</p>
                    <p className="mt-1 text-xs text-zinc-400">{currentTime.toFixed(3)} s</p>
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <p className="text-xs tracking-[0.2em] text-zinc-500">Queue utilization</p>
                    <p className="mt-2 text-lg font-semibold">{queueUtilization.toFixed(0)}%</p>
                    <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-800">
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
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <p className="text-xs tracking-[0.2em] text-zinc-500">Sojourn</p>
                    <p className="mt-2 text-lg font-semibold">{formatMs(nearestSojourn?.delayMs)}</p>
                    <p className="mt-1 text-xs text-zinc-400">avg {formatMs(avgSojourn)}</p>
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <p className="text-xs tracking-[0.2em] text-zinc-500">Drops</p>
                    <p className="mt-2 text-lg font-semibold">{packetsLost}</p>
                    <p className={`mt-1 text-xs ${dropIsActive ? "text-rose-400" : "text-zinc-400"}`}>
                      {dropIsActive ? "drop active" : "stable"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>{currentTime.toFixed(3)}s</span>
                  <span>
                    peak {peakQueue} pkt / cap {queueCapacity}
                  </span>
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
                    <div className="flex h-50 items-end gap-[2px] rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
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
                  </div>
                )}
              </article>

              <article>
                <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {recentEvents.length === 0 ? (
                    <p className="text-sm text-zinc-500">No events visible.</p>
                  ) : (
                    recentEvents.map((event, index) => {
                      return (
                        <div
                          key={`${event.type}-${event.linkId}-${event.time}-${index}`}
                          className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-normal text-zinc-100">{event.type}</p>
                            <p className="font-mono text-xs text-zinc-500">{event.time.toFixed(4)}s</p>
                          </div>
                          <p className="mt-1 text-xs text-zinc-500">{event.linkId}</p>
                          <p className="mt-2 text-sm text-zinc-400">{summarizeEvent(event)}</p>
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