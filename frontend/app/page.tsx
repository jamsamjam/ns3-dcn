"use client";

import { useMemo, useState } from "react";

type RunResponse = unknown;

type Node = {
  id: string;
  label: string;
  type: "core" | "agg" | "access" | "host";
  x: number;
  y: number;
};

type Link = {
  from: string;
  to: string;
};

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

      nodes.push({
        id: aggId,
        label: `P${p} A${a}`,
        type: "agg",
        x: podX + a * 70,
        y: aggY,
      });

      for (let c = 0; c < half; c++) {
        links.push({
          from: aggId,
          to: `core-${a * half + c}`,
        });
      }
    }

    for (let e = 0; e < half; e++) {
      const accessId = `pod-${p}-access-${e}`;

      nodes.push({
        id: accessId,
        label: `P${p} E${e}`,
        type: "access",
        x: podX + e * 70,
        y: accessY,
      });

      for (let a = 0; a < half; a++) {
        links.push({
          from: accessId,
          to: `pod-${p}-agg-${a}`,
        });
      }

      for (let h = 0; h < half; h++) {
        const hostId = `pod-${p}-host-${e}-${h}`;

        nodes.push({
          id: hostId,
          label: `H${p}.${e}.${h}`,
          type: "host",
          x: podX + e * 70 - 18 + h * 36,
          y: hostY,
        });

        links.push({
          from: hostId,
          to: accessId,
        });
      }
    }
  }

  return { nodes, links, error: null };
}

function nodeStroke(type: Node["type"]) {
  if (type === "core") return "rgb(186, 186, 186)";
  if (type === "agg") return "rgb(62, 117, 255)";
  if (type === "access") return "rgb(138, 197, 255)";
  return "rgb(212 212 216)";
}

export default function Home() {
  const [linkRate, setLinkRate] = useState("10Mbps");
  const [linkDelay, setLinkDelay] = useState("1ms");
  const [k, setK] = useState("4");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);

  const numericK = Number(k);
  const svgWidth = Math.max(900, numericK * 220);
  const svgHeight = 500;
  const startX = 80;

  const topology = useMemo(
    () => buildFatTree(numericK, startX),
    [numericK, startX]
  );

  const nodeMap = useMemo(() => {
    return new Map(topology.nodes.map((node) => [node.id, node]));
  }, [topology.nodes]);

  const hostCount =
    Number.isInteger(numericK) && numericK >= 2 && numericK % 2 === 0
      ? Math.pow(numericK, 3) / 4
      : 0;

  const pods =
    Number.isInteger(numericK) && numericK >= 2 && numericK % 2 === 0
      ? numericK
      : 0;

  const switches =
    Number.isInteger(numericK) && numericK >= 2 && numericK % 2 === 0
      ? (5 * Math.pow(numericK, 2)) / 4
      : 0;

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
          linkRate,
          linkDelay,
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
        <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-400">
              ns-3 visualization
            </p>
            <h1 className="mt-3 text-3xl font-semibold">
              Fat-Tree Topology
            </h1>
          </div>

          <div className="w-fit rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-3">
            <input
              value={linkRate}
              onChange={(event) => setLinkRate(event.target.value)}
              className="h-11 w-40 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              placeholder="10Mbps"
            />

            <input
              value={linkDelay}
              onChange={(event) => setLinkDelay(event.target.value)}
              className="h-11 w-32 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              placeholder="1ms"
            />

            <input
              value={k}
              onChange={(event) => setK(event.target.value)}
              className="h-11 w-20 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              placeholder="k"
            />

            <button
              onClick={runSimulation}
              disabled={loading || Boolean(topology.error)}
              className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:opacity-60"
            >
              {loading ? "Running..." : "Run"}
            </button>
          </div>

          {topology.error ? (
            <p className="mt-2 text-sm text-rose-400">{topology.error}</p>
          ) : null}

          {error ? (
            <p className="mt-2 text-sm text-rose-400">{error}</p>
          ) : null}

          {result ? (
            <pre className="mt-2 max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
              {JSON.stringify(result, null, 2)}
            </pre>
          ) : null}
        </div>
        </header>

        <section className="overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-4 flex flex-wrap gap-4 text-xs text-zinc-400">
            <span>
              <span
                className={`mr-2 inline-block h-3 w-3 rounded-full border-2`}
                style={{ borderColor: nodeStroke("core") }}
              />              
                Core
            </span>
            <span>
              <span
                className={`mr-2 inline-block h-3 w-3 rounded-full border-2`}
                style={{ borderColor: nodeStroke("agg") }}
              />  
               Aggregate
            </span>
            <span>
              <span
                className={`mr-2 inline-block h-3 w-3 rounded-full border-2`}
                style={{ borderColor: nodeStroke("access") }}
              />  
                Access
            </span>
            <span>
              <span
                className={`mr-2 inline-block h-3 w-3 rounded-full border-2`}
                style={{ borderColor: nodeStroke("host") }}
              />  
                Host
            </span>
          </div>

          <svg width={svgWidth} height={svgHeight} className="mx-auto block">
            {topology.links.map((link, index) => {
              const from = nodeMap.get(link.from);
              const to = nodeMap.get(link.to);

              if (!from || !to) return null;

              return (
                <line
                  key={`${link.from}-${link.to}-${index}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="rgb(63 63 70)"
                  strokeWidth="1"
                />
              );
            })}

            {topology.nodes.map((node) => {
              const isHost = node.type === "host";

              return (
                <g key={node.id}>
                  {isHost ? (
                    <rect
                      x={node.x - 10}
                      y={node.y - 8}
                      width="20"
                      height="16"
                      rx="4"
                      fill="none"
                      stroke={nodeStroke(node.type)}
                      strokeWidth="2"
                    />
                  ) : (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r="16"
                      fill="none"
                      stroke={nodeStroke(node.type)}
                      strokeWidth="2"
                    />
                  )}

                  <text
                    x={node.x}
                    y={node.y + 31}
                    textAnchor="middle"
                    className="fill-zinc-400 text-[10px]"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </section>
      </div>
    </main>
  );
}