"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type QueueLenChange = {
  time: number;
  oldPackets?: number;
  newPackets?: number;
};

type DelaySample = {
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

type PacketArrival = {
  time: number;
  packetId?: number;
  size?: number;
};

type TraceMetrics = {
  maxQueueSize?: number;
  packetsLost?: number;
  packetsQueued?: number;
  avgDelayMs?: number;
};

type LinkTrace = {
  queueLenChanges?: QueueLenChange[];
  delaySamples?: DelaySample[];
  packetDrops?: PacketDrop[];
  packetDequeues?: PacketDequeue[];
  packetArrivals?: PacketArrival[];
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

type TopologyConfig = {
  topology?: string;
  links?: TraceLink[];
};

type TimelineEvent =
  | ({ type: "QUEUE_LEN_CHANGE"; linkId: string } & QueueLenChange)
  | ({ type: "DELAY_SAMPLE"; linkId: string } & DelaySample)
  | ({ type: "PACKET_DROP"; linkId: string } & PacketDrop)
  | ({ type: "PACKET_ARRIVAL"; linkId: string } & PacketArrival)
  | ({ type: "PACKET_DEQUEUE"; linkId: string } & PacketDequeue);

type QueuePoint = {
  time: number;
  packets: number;
  raw: Extract<TimelineEvent, { type: "QUEUE_LEN_CHANGE" }>;
};

type PacketMotion = {
  id: string;
  linkId: string;
  position: number;
  kind: "send" | "drain" | "egress" | "drop";
};

type RouterPanelStats = {
  hasData: boolean;
  currentPackets: number;
  queueUtilization: number;
  avgDelayMs?: number;
  drops: number;
  dropIsActive: boolean;
};

type PacketRow = {
  id: number;
  size: number;
  enqueueTime: number;
  dequeueTime: number;
};

function parseCsv(text: string): PacketRow[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const rows: PacketRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 4) continue;
    const id = Number(parts[0]);
    const size = Number(parts[1]);
    const enqueueTime = Number(parts[2]);
    const dequeueTime = Number(parts[3]);
    if (!Number.isFinite(id) || !Number.isFinite(size) || !Number.isFinite(enqueueTime) || !Number.isFinite(dequeueTime)) continue;
    rows.push({ id, size, enqueueTime, dequeueTime });
  }
  return rows;
}

function deriveLinkTrace(rows: PacketRow[]): LinkTrace {
  if (rows.length === 0) return {};

  const packetArrivals: PacketArrival[] = rows.map((r) => ({
    time: r.enqueueTime,
    packetId: r.id,
    size: r.size,
  }));

  const packetDequeues: PacketDequeue[] = rows.map((r) => ({
    time: r.dequeueTime,
    packetId: r.id,
    size: r.size,
  }));

  const delaySamples: DelaySample[] = rows.map((r) => ({
    time: r.dequeueTime,
    delayMs: (r.dequeueTime - r.enqueueTime) * 1000,
  }));

  // Derive queue depth: enqueue = +1, dequeue = -1; enqueues before dequeues at same time
  type QueueEvent = { time: number; delta: 1 | -1 };
  const events: QueueEvent[] = [
    ...rows.map((r) => ({ time: r.enqueueTime, delta: 1 as const })),
    ...rows.map((r) => ({ time: r.dequeueTime, delta: -1 as const })),
  ].sort((a, b) => a.time - b.time || b.delta - a.delta);

  const queueLenChanges: QueueLenChange[] = [];
  let depth = 0;
  for (const ev of events) {
    const old = depth;
    depth = Math.max(depth + ev.delta, 0);
    queueLenChanges.push({ time: ev.time, oldPackets: old, newPackets: depth });
  }

  const avgDelayMs =
    delaySamples.reduce((sum, s) => sum + (s.delayMs ?? 0), 0) / delaySamples.length;

  return {
    packetArrivals,
    packetDequeues,
    delaySamples,
    queueLenChanges,
    metrics: { packetsQueued: rows.length, avgDelayMs },
  };
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

function parseRateMbps(value?: string): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(/([\d.]+)/);
  if (!match) {
    return null;
  }
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes("gbps")) {
    return numeric * 1000;
  }
  if (lower.includes("kbps")) {
    return numeric / 1000;
  }
  return numeric;
}

function parseDelayMs(value?: string): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(/([\d.]+)/);
  if (!match) {
    return null;
  }
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes("s") && !lower.includes("ms")) {
    return numeric * 1000;
  }
  return numeric;
}

function estimateTravelSeconds(link: TraceLink | null, fallbackSeconds: number): number {
  if (!link) {
    return fallbackSeconds;
  }

  const rateMbps = parseRateMbps(link.rate) ?? 5;
  const delayMs = parseDelayMs(link.delay) ?? 10;

  // Higher bandwidth -> faster motion, higher delay -> slower motion.
  const fromRate = 0.035 + 0.28 / Math.max(rateMbps, 0.2);
  const fromDelay = (delayMs / 1000) * 0.55;
  return clamp(fromRate + fromDelay, 0.05, 0.8);
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

    for (const event of trace?.delaySamples ?? []) {
      events.push({
        type: "DELAY_SAMPLE",
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

    for (const event of trace?.packetArrivals ?? []) {
      events.push({
        type: "PACKET_ARRIVAL",
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

function inferBottleneckLink(links: TraceLink[]): TraceLink | null {
  if (links.length === 0) {
    return null;
  }

  let best: TraceLink | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const link of links) {
    const queueEvents = link.trace?.queueLenChanges ?? [];
    const drops = link.trace?.packetDrops ?? [];
    const rateMbps = parseRateMbps(link.rate) ?? 100;
    const delayMs = parseDelayMs(link.delay) ?? 0;

    const peakQueue = queueEvents.reduce((max, event) => Math.max(max, event.newPackets ?? 0), 0);
    const avgDelay = link.trace?.metrics?.avgDelayMs ?? 0;

    // Prioritize links that actually exhibit congestion signs.
    const bottleneckLikeRate = 18 / Math.max(rateMbps, 0.1);
    const bottleneckLikeDelay = delayMs * 0.22;
    const score =
      peakQueue * 3 +
      drops.length * 12 +
      avgDelay * 0.08 +
      (queueEvents.length > 0 ? 1 : 0) +
      bottleneckLikeRate +
      bottleneckLikeDelay;

    if (score > bestScore) {
      best = link;
      bestScore = score;
    }
  }

  if (bestScore <= 0) {
    return links[Math.floor((links.length - 1) / 2)] ?? links[0] ?? null;
  }

  return best;
}

function buildPacketMotions(
  queueEvents: QueuePoint[],
  arrivalEvents: PacketArrival[],
  dequeueEvents: PacketDequeue[],
  currentTime: number,
  ingressLinkId: string,
  bottleneckLinkId: string,
  egressLinkId: string | null,
  currentPackets: number,
  sendTravelSeconds: number,
  drainTravelSeconds: number,
  egressTravelSeconds: number
): PacketMotion[] {
  const motions: PacketMotion[] = [];
  const activeTime = currentTime;
  const queueWindowSeconds = 0.8;
  const dequeueWindowSeconds = 0.8;
  const arrivalWindowSeconds = 0.8;

  const recentQueueEvents = queueEvents.filter(
    (event) => event.time <= activeTime && activeTime - event.time <= queueWindowSeconds
  );
  const arrivalBursts = arrivalEvents.filter(
    (event) => event.time <= activeTime && activeTime - event.time <= arrivalWindowSeconds
  ).length;

  const queueBursts = recentQueueEvents.reduce((acc, event) => {
    const delta = (event.raw.newPackets ?? 0) - (event.raw.oldPackets ?? 0);
    return acc + Math.max(delta, 0);
  }, 0);

  const enqueueBursts = Math.max(arrivalBursts, queueBursts);

  const recentDequeues = dequeueEvents.filter(
    (event) => event.time <= activeTime && activeTime - event.time <= dequeueWindowSeconds
  );

  // Show ingress animation when packets are flowing even if the queue is transiently empty
  // (happens when enqueue+dequeue occur at the same simulation timestamp).
  const sendCount = currentPackets > 0 || enqueueBursts > 0
    ? clamp(Math.round(currentPackets / 12) + Math.min(Math.max(enqueueBursts, 2), 4), 1, 8)
    : 0;
  const drainCount = recentDequeues.length > 0
    ? clamp(Math.round(recentDequeues.length / 2), 1, 7)
    : 0;

  const sendBasePhase = (activeTime / sendTravelSeconds) % 1;
  for (let i = 0; i < sendCount; i += 1) {
    const phase = (sendBasePhase + i / Math.max(sendCount, 1)) % 1;
    motions.push({
      id: `send-stream-${i}`,
      linkId: ingressLinkId,
      position: 5 + phase * 90,
      kind: "send",
    });
  }

  const drainBasePhase = (activeTime / drainTravelSeconds) % 1;
  for (let i = 0; i < drainCount; i += 1) {
    const phase = (drainBasePhase + i / Math.max(drainCount, 1)) % 1;
    motions.push({
      id: `drain-stream-${i}`,
      linkId: bottleneckLinkId,
      position: 5 + phase * 90,
      kind: "drain",
    });
  }

  if (egressLinkId && drainCount > 0) {
    const egressBasePhase = (activeTime / egressTravelSeconds) % 1;
    for (let i = 0; i < drainCount; i += 1) {
      const phase = (egressBasePhase + i / Math.max(drainCount, 1)) % 1;
      motions.push({
        id: `egress-stream-${i}`,
        linkId: egressLinkId,
        position: 5 + phase * 90,
        kind: "egress",
      });
    }
  }

  return motions;
}

function summarizeEvent(event: TimelineEvent): string {
  if (event.type === "QUEUE_LEN_CHANGE") {
    return `[${event.linkId}] ${event.oldPackets ?? 0} -> ${event.newPackets ?? 0}`;
  }
  if (event.type === "DELAY_SAMPLE") {
    return `[${event.linkId}] ${event.delayMs ?? 0} ms queueing delay`;
  }
  if (event.type === "PACKET_DROP") {
    return `[${event.linkId}] packet ${event.packetId ?? "?"} dropped (${event.size ?? "?"} B)`;
  }
  if (event.type === "PACKET_ARRIVAL") {
    return `[${event.linkId}] packet ${event.packetId ?? "?"} arrived (${event.size ?? "?"} B)`;
  }
  if (event.type === "PACKET_DEQUEUE") {
    return `[${event.linkId}] packet ${event.packetId ?? "?"} dequeued (${event.size ?? "?"} B)`;
  }
  return "";
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState("http://localhost:8000");
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [topologyConfig, setTopologyConfig] = useState<TopologyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);

  const links = useMemo(() => {
    const traceLinks = trace?.links ?? [];
    const configLinks = topologyConfig?.links ?? [];

    if (traceLinks.length === 0) {
      return configLinks;
    }
    if (configLinks.length === 0) {
      return traceLinks;
    }

    const traceById = new Map(traceLinks.map((link) => [link.linkId, link]));
    const merged = configLinks.map((configLink) => {
      const traced = traceById.get(configLink.linkId);
      if (!traced) {
        return configLink;
      }
      return {
        ...configLink,
        ...traced,
        trace: traced.trace ?? configLink.trace,
      };
    });

    const existingIds = new Set(merged.map((link) => link.linkId));
    const traceOnly = traceLinks.filter((link) => !existingIds.has(link.linkId));

    return [...merged, ...traceOnly];
  }, [trace?.links, topologyConfig?.links]);
  const allEvents = useMemo(() => flattenTimeline(links), [links]);

  const bottleneckLink = useMemo(() => inferBottleneckLink(links), [links]);
  const routerNodeId = useMemo(() => {
    if (!bottleneckLink) {
      return 1;
    }

    const candidates = [bottleneckLink.from, bottleneckLink.to];
    const shared = candidates.find((nodeId) =>
      links.some(
        (link) =>
          link.linkId !== bottleneckLink.linkId &&
          (link.from === nodeId || link.to === nodeId)
      )
    );

    return shared ?? bottleneckLink.from;
  }, [links, bottleneckLink]);

  const ingressLink = useMemo(() => {
    if (!bottleneckLink) {
      return links[0] ?? null;
    }

    const incoming = links.find((link) => link.to === routerNodeId && link.linkId !== bottleneckLink.linkId);
    if (incoming) {
      return incoming;
    }

    const adjacentToRouter = links.filter(
      (link) =>
        link.linkId !== bottleneckLink.linkId &&
        (link.from === routerNodeId || link.to === routerNodeId)
    );

    if (adjacentToRouter.length === 0) {
      return links[0] ?? null;
    }

    // Prefer edge-like endpoints (degree 1) as ingress source candidates.
    const withEndpointPriority = adjacentToRouter
      .map((link) => {
        const otherNode = link.from === routerNodeId ? link.to : link.from;
        const otherDegree = links.reduce((count, l) => {
          if (l.from === otherNode || l.to === otherNode) {
            return count + 1;
          }
          return count;
        }, 0);
        return { link, otherDegree };
      })
      .sort((a, b) => a.otherDegree - b.otherDegree);

    return withEndpointPriority[0]?.link ?? adjacentToRouter[0] ?? null;
  }, [links, bottleneckLink, routerNodeId]);

  const egressLink = useMemo(() => {
    if (!bottleneckLink) {
      return null;
    }

    const outgoing = links.find((link) => link.from === bottleneckLink.to && link.linkId !== bottleneckLink.linkId);
    if (outgoing) {
      return outgoing;
    }

    const adjacentToBottleneckDst = links.filter(
      (link) =>
        link.linkId !== bottleneckLink.linkId &&
        (link.from === bottleneckLink.to || link.to === bottleneckLink.to)
    );

    return adjacentToBottleneckDst[0] ?? null;
  }, [links, bottleneckLink]);

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

  const bottleneckTimeline = useMemo(() => {
    if (!bottleneckLink?.trace) {
      return [] as number[];
    }

    const times = [
      ...(bottleneckLink.trace.queueLenChanges ?? []).map((event) => event.time),
      ...(bottleneckLink.trace.delaySamples ?? []).map((event) => event.time),
      ...(bottleneckLink.trace.packetDrops ?? []).map((event) => event.time),
      ...(bottleneckLink.trace.packetDequeues ?? []).map((event) => event.time),
    ];

    if (times.length === 0) {
      return [] as number[];
    }

    return Array.from(new Set(times)).sort((a, b) => a - b);
  }, [bottleneckLink]);

  const dropEvents = useMemo(() => bottleneckLink?.trace?.packetDrops ?? [], [bottleneckLink]);
  const arrivalEvents = useMemo(() => bottleneckLink?.trace?.packetArrivals ?? [], [bottleneckLink]);
  const dequeueEvents = useMemo(() => bottleneckLink?.trace?.packetDequeues ?? [], [bottleneckLink]);

  const queueCapacity = useMemo(() => {
    const parsed = parsePacketCount(trace?.queueSize);
    return parsed ?? Math.max(...queueEvents.map((event) => event.packets), 1);
  }, [trace?.queueSize, queueEvents]);

  const boundedPlayIndex = Math.min(playIndex, Math.max(bottleneckTimeline.length - 1, 0));
  const currentTime = bottleneckTimeline[boundedPlayIndex] ?? 0;

  const activeQueuePoint = [...queueEvents]
    .filter((event) => event.time <= currentTime)
    .at(-1) ?? null;
  const activePackets = activeQueuePoint?.packets ?? 0;

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
    if (!ingressLink || !bottleneckLink) {
      return [];
    }

    const ingressTravelSeconds = estimateTravelSeconds(ingressLink, 0.08);
    const bottleneckTravelSeconds = estimateTravelSeconds(bottleneckLink, 0.12);
    const egressTravelSeconds = estimateTravelSeconds(egressLink, 0.08);

    return buildPacketMotions(
      queueEvents,
      arrivalEvents,
      dequeueEvents,
      currentTime,
      ingressLink.linkId,
      bottleneckLink.linkId,
      egressLink?.linkId ?? null,
      activePackets,
      ingressTravelSeconds,
      bottleneckTravelSeconds,
      egressTravelSeconds
    );
  }, [queueEvents, arrivalEvents, dequeueEvents, currentTime, ingressLink, bottleneckLink, egressLink, activePackets]);

  useEffect(() => {
    const sendIds = packetMotions
      .filter((motion) => motion.kind === "send")
      .map((motion) => motion.id);

    if (sendIds.length === 0) {
      return;
    }
  }, [packetMotions]);

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

  const nodeIds = useMemo(() => {
    const unique = new Set<number>();
    for (const link of links) {
      unique.add(link.from);
      unique.add(link.to);
    }
    return Array.from(unique).sort((a, b) => a - b);
  }, [links]);

  const nodeLeftById = useMemo(() => {
    const map = new Map<number, number>();
    if (nodeIds.length === 0) {
      return map;
    }
    if (nodeIds.length === 1) {
      map.set(nodeIds[0], 50);
      return map;
    }

    const minLeft = 6;
    const maxLeft = 94;
    const step = (maxLeft - minLeft) / (nodeIds.length - 1);

    nodeIds.forEach((nodeId, index) => {
      map.set(nodeId, minLeft + step * index);
    });

    return map;
  }, [nodeIds]);

  const nodeDegreeById = useMemo(() => {
    const map = new Map<number, number>();
    for (const link of links) {
      map.set(link.from, (map.get(link.from) ?? 0) + 1);
      map.set(link.to, (map.get(link.to) ?? 0) + 1);
    }
    return map;
  }, [links]);

  const routerNodeIds = useMemo(() => {
    return nodeIds.filter((nodeId, index) => {
      const isFirst = index === 0;
      const isLast = index === nodeIds.length - 1;
      const degree = nodeDegreeById.get(nodeId) ?? 0;
      return degree >= 2 && !isFirst && !isLast;
    });
  }, [nodeIds, nodeDegreeById]);

  const linkById = useMemo(() => {
    const map = new Map<string, TraceLink>();
    for (const link of links) {
      map.set(link.linkId, link);
    }
    return map;
  }, [links]);

  const routerLinkByNode = useMemo(() => {
    const map = new Map<number, TraceLink | null>();

    for (const nodeId of routerNodeIds) {
      const connectedLinks = links.filter((link) => link.from === nodeId || link.to === nodeId);

      let best: TraceLink | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const link of connectedLinks) {
        const queueCount = link.trace?.queueLenChanges?.length ?? 0;
        const delayCount = link.trace?.delaySamples?.length ?? 0;
        const dropCount = link.trace?.packetDrops?.length ?? 0;
        const arrivalCount = link.trace?.packetArrivals?.length ?? 0;
        const dequeueCount = link.trace?.packetDequeues?.length ?? 0;
        const score = queueCount * 5 + delayCount * 3 + dropCount * 4 + arrivalCount * 2 + dequeueCount;

        if (score > bestScore) {
          best = link;
          bestScore = score;
        }
      }

      map.set(nodeId, best ?? connectedLinks[0] ?? null);
    }

    return map;
  }, [links, routerNodeIds]);

  const routerPanelStatsByNode = useMemo(() => {
    const map = new Map<number, RouterPanelStats>();
    const parsedCapacity = parsePacketCount(trace?.queueSize) ?? 1;

    for (const nodeId of routerNodeIds) {
      const tracedLink =
        nodeId === routerNodeId
          ? bottleneckLink
          : routerLinkByNode.get(nodeId) ?? null;
      const queueLenChanges = tracedLink?.trace?.queueLenChanges ?? [];
      const delaySamples = tracedLink?.trace?.delaySamples ?? [];
      const packetDrops = tracedLink?.trace?.packetDrops ?? [];
      const packetArrivals = tracedLink?.trace?.packetArrivals ?? [];
      const packetDequeues = tracedLink?.trace?.packetDequeues ?? [];

      const visibleQueueEvents = queueLenChanges.filter((event) => event.time <= currentTime);
      const latestQueueEvent = visibleQueueEvents.length > 0 ? visibleQueueEvents[visibleQueueEvents.length - 1] : null;
      const fallbackPackets = clamp(
        packetArrivals.filter((event) => event.time <= currentTime).length -
          packetDequeues.filter((event) => event.time <= currentTime).length -
          packetDrops.filter((event) => event.time <= currentTime).length,
        0,
        Number.MAX_SAFE_INTEGER
      );
      const currentPackets = latestQueueEvent?.newPackets ?? fallbackPackets;
      const queueUtilization = clamp((currentPackets / Math.max(parsedCapacity, 1)) * 100, 0, 100);

      const avgDelayMsVal = tracedLink?.trace?.metrics?.avgDelayMs;

      const visibleDrops = packetDrops.filter((event) => event.time <= currentTime);
      const recentDropForNode = visibleDrops.length > 0 ? visibleDrops[visibleDrops.length - 1] : null;
      const dropIsActive = Boolean(recentDropForNode && currentTime - recentDropForNode.time < 0.4);

      map.set(nodeId, {
        hasData:
          queueLenChanges.length > 0 ||
          delaySamples.length > 0 ||
          packetDrops.length > 0 ||
          packetArrivals.length > 0 ||
          packetDequeues.length > 0,
        currentPackets,
        queueUtilization,
        avgDelayMs: avgDelayMsVal,
        drops: visibleDrops.length,
        dropIsActive,
      });
    }

    return map;
  }, [routerNodeIds, routerLinkByNode, currentTime, trace?.queueSize, bottleneckLink, routerNodeId]);

  const dropIsActive = Boolean(recentDrop && currentTime - recentDrop.time < 0.4);

  useEffect(() => {
    if (!isPlaying || bottleneckTimeline.length === 0) {
      return;
    }

    const timer = window.setInterval(function () {
      setPlayIndex(function (prev) {
        if (prev >= bottleneckTimeline.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 40);

    return function cleanup() {
      window.clearInterval(timer);
    };
  }, [isPlaying, bottleneckTimeline.length]);

  useEffect(() => {
    setPlayIndex(0);
    setIsPlaying(false);
  }, [trace]);

  async function loadFromUrl() {
    setLoading(true);
    setError(null);

    try {
      const base = sourceUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/results`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Backend returned ${res.status} from ${base}/results`);

      const { linkIds, topology } = (await res.json()) as {
        linkIds: string[];
        topology: { links: { linkId: string; from: number; to: number; delay: string }[] } | null;
      };

      if (!linkIds?.length) throw new Error("No CSV results found on backend.");

      const topoLinks: TraceLink[] = topology?.links?.map((l) => ({ ...l, rate: "" })) ?? linkIds.map((id) => {
        const [from, to] = id.split("-").map(Number);
        return { linkId: id, from: from ?? 0, to: to ?? 1, rate: "", delay: "" };
      });

      const links: TraceLink[] = await Promise.all(
        topoLinks.map(async (link) => {
          const csvRes = await fetch(`${base}/output/packets_${link.linkId}.csv`, { cache: "no-store" });
          if (!csvRes.ok) return link;
          const rows = parseCsv(await csvRes.text());
          return { ...link, trace: deriveLinkTrace(rows) };
        })
      );

      setTrace({ links });
      setTopologyConfig(null);
    } catch (err) {
      setTrace(null);
      setError(err instanceof Error ? err.message : "Unknown error while loading results.");
    } finally {
      setLoading(false);
    }
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    setError(null);
    setLoading(true);

    try {
      const jsonFile = files.find((f) => f.name.endsWith(".json"));
      const csvFiles = files.filter((f) => f.name.endsWith(".csv"));

      if (!csvFiles.length) throw new Error("No CSV files selected. Upload packets_*.csv files.");

      const topology = jsonFile
        ? (JSON.parse(await jsonFile.text()) as { links: TraceLink[] })
        : null;

      const csvMap = new Map(
        await Promise.all(
          csvFiles.map(async (f) => {
            const linkId = f.name.replace(/^packets_/, "").replace(/\.csv$/, "");
            return [linkId, parseCsv(await f.text())] as const;
          })
        )
      );

      const topoLinks: TraceLink[] = topology?.links ?? Array.from(csvMap.keys()).map((id) => {
        const [from, to] = id.split("-").map(Number);
        return { linkId: id, from: from ?? 0, to: to ?? 1, rate: "", delay: "" };
      });

      const links: TraceLink[] = topoLinks.map((link) => {
        const rows = csvMap.get(link.linkId);
        return rows ? { ...link, trace: deriveLinkTrace(rows) } : link;
      });

      setTrace({ links });
      setTopologyConfig(null);
    } catch (err) {
      setTrace(null);
      setError(err instanceof Error ? err.message : "Invalid files.");
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
                placeholder="http://localhost:8000"
              />
              <button
                onClick={loadFromUrl}
                disabled={loading}
                className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-60"
              >
                {loading ? "Loading..." : "Load"}
              </button>
              <label className="flex h-11 cursor-pointer items-center rounded-xl border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800">
                Upload CSVs
                <input type="file" accept=".csv,.json" multiple onChange={onFileChange} className="hidden" />
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

                <div className="relative hidden h-[370px] md:block">
                  {links.map((link) => {
                    const fromLeft = nodeLeftById.get(link.from) ?? 50;
                    const toLeft = nodeLeftById.get(link.to) ?? 50;
                    const left = Math.min(fromLeft, toLeft);
                    const width = Math.abs(toLeft - fromLeft);
                    const labelLeft = left + width / 2;
                    const isBottleneck = link.linkId === bottleneckLink?.linkId;

                    return (
                      <div key={`link-${link.linkId}`}>
                        <div
                          className={`absolute top-[49%] -translate-y-1/2 transition-all duration-150 ${
                            isBottleneck
                              ? "h-[3px] bg-zinc-700"
                              : "h-[2px] bg-zinc-700"
                          }`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        />

                        <div className="absolute top-[37%] -translate-x-1/2 text-center" style={{ left: `${labelLeft}%` }}>
                          <p className="text-xs text-zinc-400">{`${link.rate ?? "—"} / ${link.delay}`}</p>
                        </div>
                      </div>
                    );
                  })}

                  {nodeIds.map((nodeId, index) => {
                    const left = `${nodeLeftById.get(nodeId) ?? 50}%`;
                    const isFirst = index === 0;
                    const isLast = index === nodeIds.length - 1;
                    const degree = nodeDegreeById.get(nodeId) ?? 0;
                    const isRouter = degree >= 2 && !isFirst && !isLast;
                    const isDropBlinkRouter = isRouter && nodeId === routerNodeId && dropIsActive;
                    const role = isRouter ? "Router" : isFirst ? "Sender" : isLast ? "Server" : "Node";

                    return (
                      <div key={`node-${nodeId}`}>
                        <div
                          className={`absolute top-[49%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-900 ${
                            isRouter
                              ? isDropBlinkRouter
                                ? "h-9 w-9 border border-amber-500"
                                : "h-9 w-9 border border-zinc-300"
                              : "h-8 w-8 border border-zinc-200"
                          }`}
                          style={{ left }}
                        />

                        <div className="absolute top-[61%] w-28 -translate-x-1/2 text-center" style={{ left }}>
                          <p className="text-sm font-semibold">n{nodeId}</p>
                          <p className="mt-1 text-xs text-zinc-400">{role}</p>
                        </div>
                      </div>
                    );
                  })}

                  {packetMotions.map((motion) => {
                    const motionLink = linkById.get(motion.linkId);
                    if (!motionLink) {
                      return null;
                    }

                    const fromLeft = nodeLeftById.get(motionLink.from) ?? 50;
                    const toLeft = nodeLeftById.get(motionLink.to) ?? 50;
                    let visualFrom = fromLeft;
                    let visualTo = toLeft;

                    // Keep visual motion direction stable regardless of raw link orientation.
                    if (motion.kind === "send" && motionLink.to !== routerNodeId) {
                      visualFrom = toLeft;
                      visualTo = fromLeft;
                    }
                    if (motion.kind === "drain" && motionLink.from !== routerNodeId) {
                      visualFrom = toLeft;
                      visualTo = fromLeft;
                    }
                    if (motion.kind === "egress" && motionLink.from !== bottleneckLink?.to) {
                      visualFrom = toLeft;
                      visualTo = fromLeft;
                    }

                    const travel = visualTo - visualFrom;
                    const baseClasses =
                      motion.kind === "drain"
                        ? "bg-emerald-400 shadow-[0_0_18px_rgba(74,222,128,0.6)]"
                        : "bg-lime-300 shadow-[0_0_18px_rgba(163,230,53,0.7)]";

                    const style = {
                      left: `${visualFrom + (travel * motion.position) / 100}%`,
                      top: "49%",
                    };

                    return (
                      <div
                        key={motion.id}
                        className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${baseClasses}`}
                        style={style}
                      />
                    );
                  })}

                  {routerNodeIds.map((panelNodeId) => {
                    const panelLeft = `${nodeLeftById.get(panelNodeId) ?? 50}%`;
                    const stats = routerPanelStatsByNode.get(panelNodeId);
                    const hasData = stats?.hasData ?? false;

                    return (
                      <div
                        key={`router-panel-${panelNodeId}`}
                        className="absolute top-[74%] w-[180px] -translate-x-1/2 rounded-md border border-zinc-700 px-4 py-3"
                        style={{ left: panelLeft }}
                      >
                        <div className="grid grid-cols-2 gap-y-1 text-sm">
                          <p className="text-zinc-400">Current</p>
                          <p className="text-right font-semibold text-zinc-100">{hasData ? `${stats?.currentPackets ?? 0} pkt` : "-"}</p>
                          <p className="text-zinc-400">Utilization</p>
                          <p className="text-right font-semibold text-zinc-100">{hasData ? `${(stats?.queueUtilization ?? 0).toFixed(0)}%` : "-"}</p>
                          <p className="text-zinc-400">Avg Delay</p>
                          <p className="text-right font-semibold text-zinc-100">{hasData ? formatMs(stats?.avgDelayMs) : "-"}</p>
                          <p className="text-zinc-400">Drops</p>
                          <p className={`text-right font-semibold ${stats?.dropIsActive ? "text-amber-500" : "text-zinc-100"}`}>
                            {hasData ? (stats?.drops ?? 0) : "-"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
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
                  max={Math.max(bottleneckTimeline.length - 1, 0)}
                  step={1}
                  value={boundedPlayIndex}
                  onChange={(event) => {
                    setIsPlaying(false);
                    setPlayIndex(Number.parseInt(event.target.value, 10));
                  }}
                  className="w-full accent-zinc-100"
                  disabled={bottleneckTimeline.length === 0}
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