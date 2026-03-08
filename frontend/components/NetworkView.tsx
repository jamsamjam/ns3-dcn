interface Node {
  id: number;
  name: string;
  x: number;
  y: number;
}

interface Link {
  id: number;
  source: number;
  target: number;
  dataRate: string;
  delay: string;
}

interface NetworkData {
  topology: {
    nodes: Node[];
    links: Link[];
  };
  events: any[];
}

type Props = {
  data: NetworkData | null;
};

export default function NetworkView({ data }: Props) {
  if (!data || !data.topology) {
    return <div>No network data available</div>;
  }

  const { nodes, links } = data.topology;

  return (
    <svg width={800} height={600}>
      {links.map((link) => {
        const source = nodes[link.source];
        const target = nodes[link.target];

        if (!source || !target) return null;

        return (
          <line
            key={link.id}
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            stroke="#999"
            strokeWidth={2}
          />
        );
      })}

      {nodes.map((node) => (
        <g key={node.id}>
          <circle
            cx={node.x}
            cy={node.y}
            r={20}
            fill="#fff"
            stroke="#999"
            strokeWidth={2}
          />
          <text
            x={node.x}
            y={node.y + 35}
            textAnchor="middle"
            fontSize={12}
            fill="#333"
          >
            {node.name}
          </text>
        </g>
      ))}
    </svg>
  );
}