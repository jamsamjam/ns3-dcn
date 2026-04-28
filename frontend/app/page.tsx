"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PacketRow = {
  id: number;
  size: number;
  enqueue_time: number;
  dequeue_time: number;
};

type RunResult = { runTag: string; linkIds: string[] };

type Node = {
  id: string;
  label: string;
  type: "core" | "agg" | "access" | "host";
  x: number;
  y: number;
};

type Link = { from: string; to: string };

// Maps C++ numeric node ID → frontend SVG node ID
function numericToSvgId(num: number, k: number): string {
  const half = k / 2;
  const numHosts = (k * k * k) / 4;
  const numEdge = (k * k) / 2;
  const numAgg = (k * k) / 2;

  if (num < numHosts) {
    const p = Math.floor(num / (half * half));
    const rem = num % (half * half);
    return `pod-${p}-host-${Math.floor(rem / half)}-${rem % half}`;
  }
  if (num < numHosts + numEdge) {
    const off = num - numHosts;
    return `pod-${Math.floor(off / half)}-access-${off % half}`;
  }
  if (num < numHosts + numEdge + numAgg) {
    const off = num - numHosts - numEdge;
    return `pod-${Math.floor(off / half)}-agg-${off % half}`;
  }
  return `core-${num - numHosts - numEdge - numAgg}`;
}

// "4-18" → ["pod-1-host-0-0", "pod-1-access-0"] or null
function parseLinkSvgIds(
  linkId: string,
  k: number
): [string, string] | null {
  const parts = linkId.split("-");
  if (parts.length !== 2) return null;
  const from = parseInt(parts[0]);
  const to = parseInt(parts[1]);
  if (isNaN(from) || isNaN(to)) return null;
  return [numericToSvgId(from, k), numericToSvgId(to, k)];
}

function buildFatTree(k: number, startX: number) {
  const nodes: Node[] = [];
  const links: Link[] = [];

  if (!Number.isInteger(k) || k < 2 || k % 2 !== 0) {
    return { nodes, links, error: "k must be an even integer >= 2" };
  }

  const half = k / 2;
  const podWidth = 220;
  const coreY = 60;
  const aggY = 180;
  const accessY = 300;
  const hostY = 420;

  const coreCount = half * half;
  const podSpan = (k - 1) * podWidth + (half - 1) * 70;
  const coreSpan = (coreCount - 1) * 90;
  const coreStartX = startX + (podSpan - coreSpan) / 2;

  for (let i = 0; i < coreCount; i++) {
    nodes.push({
      id: `core-${i}`,
      label: `C${i}`,
      type: "core",
      x: coreStartX + i * 90,
      y: coreY,
    });
  }

  for (let p = 0; p < k; p++) {
    const podX = startX + p * podWidth;

    for (let a = 0; a < half; a++) {
      const aggId = `pod-${p}-agg-${a}`;
      nodes.push({ id: aggId, label: `P${p} A${a}`, type: "agg", x: podX + a * 70, y: aggY });
      for (let c = 0; c < half; c++) {
        links.push({ from: aggId, to: `core-${a * half + c}` });
      }
    }

    for (let e = 0; e < half; e++) {
      const accessId = `pod-${p}-access-${e}`;
      nodes.push({ id: accessId, label: `P${p} E${e}`, type: "access", x: podX + e * 70, y: accessY });
      for (let a = 0; a < half; a++) {
        links.push({ from: accessId, to: `pod-${p}-agg-${a}` });
      }
      for (let h = 0; h < half; h++) {
        const hostId = `pod-${p}-host-${e}-${h}`;
        nodes.push({ id: hostId, label: `H${p}.${e}.${h}`, type: "host", x: podX + e * 70 - 18 + h * 36, y: hostY });
        links.push({ from: hostId, to: accessId });
      }
    }
  }

  return { nodes, links, error: null };
}

function nodeStroke(type: Node["type"]) {
  if (type === "core") return "rgb(186, 186, 186)";
  if (type === "agg") return "rgb(62, 117, 255)";
  if (type === "access") return "rgb(138, 197, 255)";
  return "rgb(212, 212, 216)";
}

// Speed presets: sim-seconds per wall-second
// 0.001 → 1ms packet visible for ~1s (ultra slow-mo)
// 0.01  → 1ms packet visible for 100ms (good default)
const SPEED_PRESETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] as const;

export default function Home() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [linkRate, setLinkRate] = useState("10Mbps");
  const [linkDelay, setLinkDelay] = useState("1ms");
  const [k, setK] = useState("4");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const [packets, setPackets] = useState<Record<string, PacketRow[]>>({});
  const [fetchingPackets, setFetchingPackets] = useState(false);

  const [animTime, setAnimTime] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [simSpeed, setSimSpeed] = useState(0.01);

  function updateSpeed(v: number) {
    simSpeedRef.current = v;
    setSimSpeed(v);
  }
  const animRaf = useRef<number | null>(null);
  const animStartSim = useRef(0);
  const simSpeedRef = useRef(0.01);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const next = saved === "light" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  const numericK = Number(k);
  const svgWidth = Math.max(900, numericK * 220);
  const svgHeight = 500;
  const startX = 80;

  const topology = useMemo(() => buildFatTree(numericK, startX), [numericK, startX]);
  const nodeMap = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n])),
    [topology.nodes]
  );

  const lineStroke = theme === "dark" ? "rgb(68, 64, 60)" : "rgb(214, 211, 209)";

  const simEndTime = useMemo(() => {
    let max = 0;
    for (const pkts of Object.values(packets)) {
      for (const p of pkts) if (p.dequeue_time > max) max = p.dequeue_time;
    }
    return max > 0 ? max : 10;
  }, [packets]);

  // rAF loop
  useEffect(() => {
    if (!animating) {
      if (animRaf.current !== null) {
        cancelAnimationFrame(animRaf.current);
        animRaf.current = null;
      }
      return;
    }

    const wallStart = performance.now();
    const simStart = animStartSim.current;

    function frame() {
      const sim = simStart + ((performance.now() - wallStart) / 1000) * simSpeedRef.current;
      if (sim >= simEndTime) {
        setAnimTime(simEndTime);
        setAnimating(false);
        return;
      }
      setAnimTime(sim);
      animRaf.current = requestAnimationFrame(frame);
    }

    animRaf.current = requestAnimationFrame(frame);
    return () => {
      if (animRaf.current !== null) {
        cancelAnimationFrame(animRaf.current);
        animRaf.current = null;
      }
    };
  }, [animating, simEndTime]);

  function toggleAnim() {
    if (animating) {
      setAnimating(false);
    } else {
      const resumeFrom = animTime >= simEndTime ? 0 : animTime;
      animStartSim.current = resumeFrom;
      setAnimTime(resumeFrom);
      setAnimating(true);
    }
  }

  async function runSimulation() {
    setLoading(true);
    setError(null);
    setRunResult(null);
    setPackets({});
    setAnimating(false);
    setAnimTime(0);

    try {
      const res = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkRate, linkDelay, k: Number(k) }),
      });
      if (!res.ok) throw new Error(`Backend Error: ${res.status}`);
      const data: RunResult = await res.json();
      setRunResult(data);

      setFetchingPackets(true);
      const fetched: Record<string, PacketRow[]> = {};
      await Promise.all(
        data.linkIds.map(async (linkId) => {
          const r = await fetch(`/results/${data.runTag}/link/${linkId}`);
          if (r.ok) {
            const d = await r.json();
            fetched[linkId] = d.packets;
          }
        })
      );
      setPackets(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setFetchingPackets(false);
    }
  }

  // Active packet dots for current animTime
  const packetDots = useMemo(() => {
    if (Object.keys(packets).length === 0) return [];
    const dots: { key: string; x: number; y: number; size: number }[] = [];

    for (const [linkId, pkts] of Object.entries(packets)) {
      const svgIds = parseLinkSvgIds(linkId, numericK);
      if (!svgIds) continue;
      const fromNode = nodeMap.get(svgIds[0]);
      const toNode = nodeMap.get(svgIds[1]);
      if (!fromNode || !toNode) continue;

      for (const p of pkts) {
        if (p.enqueue_time > animTime || p.dequeue_time < animTime) continue;
        const dur = p.dequeue_time - p.enqueue_time;
        const progress = dur > 0 ? (animTime - p.enqueue_time) / dur : 0;
        dots.push({
          key: `${linkId}-${p.id}`,
          x: fromNode.x + (toNode.x - fromNode.x) * progress,
          y: fromNode.y + (toNode.y - fromNode.y) * progress,
          size: Math.min(Math.max(p.size / 100, 4), 10),
        });
      }
    }
    return dots;
  }, [animTime, packets, nodeMap, numericK]);

  const hasPackets = Object.keys(packets).length > 0;

  return (
    <>
      <button
        onClick={toggleTheme}
        className="fixed right-5 top-5 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white shadow-sm transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800"
        aria-label="Toggle theme"
      >
        <img src="/sun.png" alt="" width={20} height={20} className={theme === "dark" ? "invert" : ""} />
      </button>

      <main className="min-h-screen bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-50">
        <div className="mx-auto max-w-7xl px-6 py-10 md:px-10">
          <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-stone-500 dark:text-stone-400">
                ns-3 visualization
              </p>
              <h1 className="mt-3 text-3xl font-semibold">Fat-Tree Topology</h1>
            </div>

            <div className="w-fit rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
              <div className="flex items-center gap-3">
                <input
                  value={linkRate}
                  onChange={(e) => setLinkRate(e.target.value)}
                  className="h-11 w-40 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="10Mbps"
                />
                <input
                  value={linkDelay}
                  onChange={(e) => setLinkDelay(e.target.value)}
                  className="h-11 w-32 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="1ms"
                />
                <input
                  value={k}
                  onChange={(e) => setK(e.target.value)}
                  className="h-11 w-20 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="k"
                />
                <button
                  onClick={runSimulation}
                  disabled={loading || Boolean(topology.error)}
                  className="h-11 rounded-xl bg-stone-900 px-4 text-sm font-medium text-stone-50 transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                >
                  {loading ? "Running..." : "Run"}
                </button>
              </div>

              {topology.error ? (
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{topology.error}</p>
              ) : null}
              {error ? (
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
              ) : null}
              {fetchingPackets ? (
                <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">Loading packets…</p>
              ) : null}
            </div>
          </header>

          <section className="relative overflow-auto rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900/40">
            {/* Legend */}
            <div className="mb-4 flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
              {(["core", "agg", "access", "host"] as Node["type"][]).map((t) => (
                <span key={t}>
                  <span
                    className="mr-2 inline-block h-3 w-3 rounded-full border-2"
                    style={{ borderColor: nodeStroke(t) }}
                  />
                  {t === "access" ? "Edge" : t.charAt(0).toUpperCase() + t.slice(1)}
                </span>
              ))}
            </div>

            <div className="absolute right-4 top-4 flex items-center gap-2">
              {hasPackets && (
                <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
                  {animTime.toFixed(3)}s / {simEndTime.toFixed(2)}s
                </span>
              )}
              <select
                value={simSpeed}
                onChange={(e) => updateSpeed(Number(e.target.value))}
                className="h-8 rounded-lg border border-stone-300 bg-stone-50 px-2 text-xs text-stone-700 outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                {SPEED_PRESETS.map((s) => (
                  <option key={s} value={s}>
                    {s < 1 ? `${s * 1000}ms/s` : `${s}x`}
                  </option>
                ))}
              </select>
              <button
                onClick={toggleAnim}
                disabled={!hasPackets}
                className="h-8 px-3 text-xs"
              >
                {animating ? "⏸" : animTime > 0 && animTime >= simEndTime ? "↺" : "▶"}
              </button>
            </div>

            <svg width={svgWidth} height={svgHeight} className="mx-auto block">
              {/* Links */}
              {topology.links.map((link, i) => {
                const from = nodeMap.get(link.from);
                const to = nodeMap.get(link.to);
                if (!from || !to) return null;
                return (
                  <line
                    key={`${link.from}-${link.to}-${i}`}
                    x1={from.x} y1={from.y}
                    x2={to.x} y2={to.y}
                    stroke={lineStroke}
                    strokeWidth="1"
                  />
                );
              })}

              {/* Nodes */}
              {topology.nodes.map((node) => {
                const isHost = node.type === "host";
                return (
                  <g key={node.id}>
                    {isHost ? (
                      <rect
                        x={node.x - 10} y={node.y - 8}
                        width="20" height="16" rx="4"
                        fill="none" stroke={nodeStroke(node.type)} strokeWidth="2"
                      />
                    ) : (
                      <circle
                        cx={node.x} cy={node.y} r="16"
                        fill="none" stroke={nodeStroke(node.type)} strokeWidth="2"
                      />
                    )}
                    <text
                      x={node.x} y={node.y + 31}
                      textAnchor="middle"
                      className="fill-stone-500 text-[10px] dark:fill-stone-400"
                    >
                      {node.label}
                    </text>
                  </g>
                );
              })}

              {/* Packet dots */}
              {packetDots.map((dot) => (
                <circle
                  key={dot.key}
                  cx={dot.x}
                  cy={dot.y}
                  r={dot.size}
                  fill="rgb(251, 191, 36)"
                  opacity={0.85}
                />
              ))}
            </svg>
          </section>
        </div>
      </main>
    </>
  );
}
