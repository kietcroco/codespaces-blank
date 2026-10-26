import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty, Spin } from "antd";
import { Bot } from "lucide-react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  getSmoothStepPath,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { request } from "../../../api/request";

/** One expert under an agency, per GET /api/agencies/org-chart's `experts` array. */
export interface AgencyOrgChartExpert {
  agent_id: string;
  name: string;
  description: string | null;
  status: string;
}

/** One agency "department" node, per GET /api/agencies/org-chart's `agencies` array. */
export interface AgencyOrgChartAgency {
  agency_id: string;
  name: string;
  color: string | null;
  experts: AgencyOrgChartExpert[];
}

interface AgencyOrgChartResponse {
  agencies: AgencyOrgChartAgency[];
}

const STATUS_DOT: Record<string, string> = {
  active: "#34d399",
  inactive: "#52525b",
  draft: "#fbbf24",
};

const DEFAULT_COLOR = "#3B3BFF";

/** Positions the user drags around are kept across data refreshes and page reloads. */
const POSITIONS_STORAGE_KEY = "octop:agency-org-chart:positions";

interface AgencyNodeData {
  label: string;
  color: string;
  expertCount: number;
}

interface ExpertNodeData {
  label: string;
  color: string;
  description: string | null;
  status: string;
}

/* ─────────────────── custom node renderers ─────────────────── */

function AgencyNode({ data }: NodeProps) {
  const d = data as unknown as AgencyNodeData;
  const initials = d.label.slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        width: 224,
        borderRadius: 16,
        border: `1px solid ${d.color}45`,
        padding: 16,
        boxShadow: `0 4px 28px ${d.color}1A`,
        background: "var(--fn-bg-elevated, #fff)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
            backgroundColor: d.color,
          }}
        >
          {initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{d.label}</p>
          <p style={{ margin: 0, fontSize: 11, opacity: 0.65 }}>
            {d.expertCount} expert{d.expertCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: d.color }} />
    </div>
  );
}

function ExpertNode({ data }: NodeProps) {
  const d = data as unknown as ExpertNodeData;
  return (
    <div
      style={{
        width: 224,
        borderRadius: 12,
        border: "1px solid rgba(100,100,100,0.3)",
        padding: 12,
        background: "var(--fn-bg-elevated, #fff)",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: d.color }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: `${d.color}18`,
            color: d.color,
          }}
        >
          <Bot size={13} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {d.label}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 10,
              opacity: 0.65,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {d.description}
          </p>
        </div>
        <span
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: "50%",
            backgroundColor: STATUS_DOT[d.status] ?? "#52525b",
          }}
        />
      </div>
    </div>
  );
}

const nodeTypes = {
  agency: AgencyNode,
  expert: ExpertNode,
};

/** Smoothstep edge tagged with the connector testid the page's tests assert on. */
function AgencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      data-testid="org-chart-connector"
    />
  );
}

const edgeTypes = { agency: AgencyEdge };

/* ─────────────────── hierarchical layout ─────────────────── */
/**
 * Ported from orchester's `apps/web/components/org/OrgCanvas.tsx` row-packing
 * algorithm, trimmed to Octop's single tier: agencies[] -> experts[]
 * (no workspace root, no flows).
 */
const COL_WIDTH_EXPERT = 240;
const COL_GAP_AGENCY = 36;
const ROW_AGENCY_Y = 0;
const ROW_EXPERT_Y = 150;
// Wrap agency rows past this width so the chart doesn't sprawl off-canvas
// once there are many departments.
const MAX_ROW_WIDTH = 2400;
const ROW_BAND_HEIGHT = 340;

// Rendered card sizes. Passed as `initialWidth`/`initialHeight` + a static
// `handles` entry so edges have a position to render from before the real
// ResizeObserver measurement lands (and in environments, like jsdom tests,
// where it never fires at all). Real browser measurement always takes
// precedence once available — see @xyflow/system's `measured ?? initial*`
// fallback chain.
const AGENCY_CARD_WIDTH = 224;
const AGENCY_CARD_HEIGHT = 96;
const EXPERT_CARD_WIDTH = 224;
const EXPERT_CARD_HEIGHT = 64;

function layoutNodes(agencies: AgencyOrgChartAgency[]): Node[] {
  type Row = { agencies: AgencyOrgChartAgency[]; width: number };
  const rows: Row[] = [];
  for (const agency of agencies) {
    const cnt = Math.max(agency.experts.length, 1);
    const width = cnt * COL_WIDTH_EXPERT;
    const last = rows[rows.length - 1];
    const withGap = (last?.width ?? 0) + (last ? COL_GAP_AGENCY : 0) + width;
    if (last && withGap <= MAX_ROW_WIDTH) {
      last.agencies.push(agency);
      last.width = withGap;
    } else {
      rows.push({ agencies: [agency], width });
    }
  }

  const out: Node[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const yOffset = r * ROW_BAND_HEIGHT;
    let cursor = -row.width / 2;
    for (const agency of row.agencies) {
      const color = agency.color ?? DEFAULT_COLOR;
      const cnt = Math.max(agency.experts.length, 1);
      const width = cnt * COL_WIDTH_EXPERT;
      const centerX = cursor + width / 2;

      out.push({
        id: `agency:${agency.agency_id}`,
        type: "agency",
        data: { label: agency.name, color, expertCount: agency.experts.length },
        position: { x: centerX - 112, y: ROW_AGENCY_Y + yOffset },
        initialWidth: AGENCY_CARD_WIDTH,
        initialHeight: AGENCY_CARD_HEIGHT,
        handles: [
          {
            type: "source",
            position: Position.Bottom,
            x: AGENCY_CARD_WIDTH / 2,
            y: AGENCY_CARD_HEIGHT,
          },
        ],
      });

      agency.experts.forEach((expert, j) => {
        const x = cursor + j * COL_WIDTH_EXPERT + (COL_WIDTH_EXPERT - 224) / 2;
        out.push({
          id: `expert:${expert.agent_id}`,
          type: "expert",
          data: {
            label: expert.name,
            color,
            description: expert.description,
            status: expert.status,
          },
          position: { x, y: ROW_EXPERT_Y + yOffset },
          initialWidth: EXPERT_CARD_WIDTH,
          initialHeight: EXPERT_CARD_HEIGHT,
          handles: [
            { type: "target", position: Position.Top, x: EXPERT_CARD_WIDTH / 2, y: 0 },
          ],
        });
      });

      cursor += width + COL_GAP_AGENCY;
    }
  }
  return out;
}

function buildEdges(agencies: AgencyOrgChartAgency[]): Edge[] {
  const edges: Edge[] = [];
  for (const agency of agencies) {
    const color = agency.color ?? DEFAULT_COLOR;
    for (const expert of agency.experts) {
      edges.push({
        id: `${agency.agency_id}-${expert.agent_id}`,
        source: `agency:${agency.agency_id}`,
        target: `expert:${expert.agent_id}`,
        type: "agency",
        style: { stroke: color, strokeWidth: 1.5 },
      });
    }
  }
  return edges;
}

export default function AgencyOrgChart(): JSX.Element {
  const [agencies, setAgencies] = useState<AgencyOrgChartAgency[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await request<AgencyOrgChartResponse>("/agencies/org-chart");
        if (active) setAgencies(data.agencies ?? []);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const edges = useMemo(() => buildEdges(agencies), [agencies]);

  // Hold mutable node state so the user can drag nodes manually; dragged
  // positions survive data refreshes (userMovedRef) and page reloads
  // (localStorage), same contract as orchester's OrgCanvas.
  const userMovedRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(POSITIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
        for (const [id, pos] of Object.entries(parsed)) {
          if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
            userMovedRef.current.set(id, pos);
          }
        }
      }
    } catch {
      // corrupt localStorage entry — ignore and start clean
    }
    hydratedRef.current = true;
  }, []);

  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      const obj: Record<string, { x: number; y: number }> = {};
      userMovedRef.current.forEach((v, k) => {
        obj[k] = v;
      });
      try {
        window.localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(obj));
      } catch {
        // quota exceeded / private mode — ignore
      }
    }, 250);
  }, []);

  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const layoutKey = useMemo(
    () =>
      agencies
        .flatMap((a) => [a.agency_id, ...a.experts.map((e) => e.agent_id)])
        .join(","),
    [agencies],
  );

  useEffect(() => {
    const computed = layoutNodes(agencies);
    const merged = computed.map((n) => {
      const moved = userMovedRef.current.get(n.id);
      return moved ? { ...n, position: moved } : n;
    });
    setFlowNodes(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setFlowNodes((nds) => {
        const next = applyNodeChanges(changes, nds);
        let touched = false;
        for (const c of changes) {
          if (c.type === "position" && c.position && !c.dragging) {
            userMovedRef.current.set(c.id, c.position);
            touched = true;
          }
        }
        if (touched) persist();
        return next;
      });
    },
    [persist],
  );

  if (loading) {
    return <Spin />;
  }

  if (agencies.length === 0) {
    return <Empty description="No agencies yet" />;
  }

  return (
    <div style={{ height: "70vh", minHeight: 480, borderRadius: 12, overflow: "hidden" }}>
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.15}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        selectionOnDrag={false}
        zoomOnScroll
        panOnScroll={false}
      >
        <Background gap={20} />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            n.type === "agency"
              ? ((n.data as unknown as AgencyNodeData).color ?? DEFAULT_COLOR)
              : ((n.data as unknown as ExpertNodeData).color ?? DEFAULT_COLOR)
          }
        />
      </ReactFlow>
    </div>
  );
}
