import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { Alert, Button, Dropdown, Input, Spin, Tag, type MenuProps } from "antd";
import { CheckCircle2, FlaskConical, History, Play, Plus, Save as SaveIcon } from "lucide-react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type NodeChange,
  type Edge,
  type EdgeChange,
  type NodeProps,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { message } from "@/utils/antdMessage";
import { request } from "../../../api/request";
import NodeInspectorDrawer from "./NodeInspectorDrawer";
import RunResultDrawer from "./RunResultDrawer";

/**
 * One node's `data.config` per spec §9. Which fields are read depends on the
 * node's `type` — `agent` nodes use `agentId`/`prompt`/`outputVar`,
 * `condition` nodes use `left`/`op`/`right`. `trigger`/`end` nodes carry an
 * empty config.
 */
export interface FlowNodeConfig {
  agentId?: string;
  prompt?: string;
  outputVar?: string;
  maxRetries?: number;
  retryDelay?: number;
  left?: string;
  op?: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains";
  right?: string;
}

/** `data` shape carried by every flow node, regardless of its `type`. */
export interface FlowNodeData {
  label: string;
  config: FlowNodeConfig;
}

export type FlowNodeType = "trigger" | "agent" | "condition" | "end";

/** One finding from `POST /flows/:flowId/validate`. */
export interface FlowIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  node_id: string | null;
}

const ISSUE_COLORS = { error: "#ef4444", warning: "#f59e0b" } as const;

/** Shape of `GET /flows/:flowId` (per backend/routers/flow.py). */
interface FlowDetail {
  flow_id: string;
  name: string;
  status: string;
  nodes: Node[];
  edges: Edge[];
}

/* ─────────────────── minimal-card node renderers ─────────────────── */

const CARD_STYLE: CSSProperties = {
  width: 180,
  borderRadius: 12,
  border: "1px solid rgba(100,100,100,0.3)",
  padding: 12,
  background: "var(--fn-bg-elevated, #fff)",
  fontSize: 12,
  fontWeight: 600,
};

function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  return (
    <div style={CARD_STYLE}>
      {d.label}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function AgentNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  return (
    <div style={CARD_STYLE}>
      <Handle type="target" position={Position.Top} />
      {d.label}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/**
 * The only branching node: two independent `source` handles so an edge
 * dragged from either one carries the matching `sourceHandle` id, letting
 * the backend engine pick the "true" vs "false" branch at run time.
 */
function ConditionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  return (
    <div style={{ ...CARD_STYLE, position: "relative" }}>
      <Handle type="target" position={Position.Top} />
      {d.label}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 10,
          opacity: 0.7,
        }}
      >
        <span>true</span>
        <span>false</span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        style={{ left: "30%", background: "#34d399" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        style={{ left: "70%", background: "#f87171" }}
      />
    </div>
  );
}

function EndNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  return (
    <div style={CARD_STYLE}>
      <Handle type="target" position={Position.Top} />
      {d.label}
    </div>
  );
}

const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  condition: ConditionNode,
  end: EndNode,
};

const NODE_TYPE_LABELS: Record<FlowNodeType, string> = {
  trigger: "Trigger",
  agent: "Agent",
  condition: "Condition",
  end: "End",
};

let nodeIdCounter = 0;
/** Unique id for a newly-added node — stable across re-renders, never reused. */
function nextNodeId(type: FlowNodeType): string {
  nodeIdCounter += 1;
  return `${type}_${Date.now()}_${nodeIdCounter}`;
}

export default function FlowCanvas({ flowId }: { flowId: string }): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [flowName, setFlowName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [flowStatus, setFlowStatus] = useState<string>("draft");
  // Drives RunResultDrawer: "run" auto-POSTs /run on open (the toolbar's
  // Run button, after saving current canvas state — see handleRun);
  // "history" opens straight to the History tab and never auto-runs (the
  // toolbar's History button). `null` keeps the drawer closed.
  const [drawerMode, setDrawerMode] = useState<"run" | "dry-run" | "history" | null>(null);
  const [inspectorNode, setInspectorNode] = useState<Node | null>(null);
  const [issues, setIssues] = useState<FlowIssue[]>([]);

  // Display-only copy of `nodes` with an outline on nodes that have issues.
  // `nodes` itself stays unstyled so Save never persists the outline.
  const displayNodes = useMemo(() => {
    const byNode = new Map<string, "error" | "warning">();
    for (const i of issues) {
      if (!i.node_id) continue;
      if (i.level === "error" || !byNode.has(i.node_id)) byNode.set(i.node_id, i.level);
    }
    if (byNode.size === 0) return nodes;
    return nodes.map((n) => {
      const level = byNode.get(n.id);
      if (!level) return n;
      return { ...n, style: { ...n.style, outline: `2px solid ${ISSUE_COLORS[level]}`, borderRadius: 12 } };
    });
  }, [nodes, issues]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await request<FlowDetail>(`/flows/${flowId}`);
        if (!active) return;
        setNodes(data.nodes ?? []);
        setEdges(data.edges ?? []);
        setFlowName(data.name ?? "");
        setSavedName(data.name ?? "");
        setFlowStatus(data.status ?? "draft");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [flowId]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  // Edges are user-created here (unlike AgencyOrgChart's read-only chart) —
  // addEdge() forwards the Connection's sourceHandle/targetHandle untouched,
  // which is what lets a ConditionNode's "true"/"false" handle reach the
  // backend engine on Save.
  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge(c, eds)),
    [],
  );

  const onNodeClick = useCallback((_event: MouseEvent, node: Node) => {
    setInspectorNode(node);
  }, []);

  const addNodeMenuItems: MenuProps["items"] = useMemo(
    () =>
      (Object.keys(NODE_TYPE_LABELS) as FlowNodeType[]).map((type) => ({
        key: type,
        label: NODE_TYPE_LABELS[type],
      })),
    [],
  );

  const handleAddNode: MenuProps["onClick"] = ({ key }) => {
    const type = key as FlowNodeType;
    const id = nextNodeId(type);
    setNodes((nds) => [
      ...nds,
      {
        id,
        type,
        position: { x: 80, y: 80 + nds.length * 90 },
        data: { label: NODE_TYPE_LABELS[type], config: {} },
      },
    ]);
  };

  /** POSTs the current canvas to the validator and shows the result. Returns
   * the issues, or `null` when the request fails (callers fail open — the
   * server still gates activate/run). */
  const runValidation = async (): Promise<FlowIssue[] | null> => {
    try {
      const res = await request<{ valid: boolean; issues?: FlowIssue[] }>(
        `/flows/${flowId}/validate`,
        { method: "POST", body: JSON.stringify({ nodes, edges }) },
      );
      const found = res?.issues ?? [];
      setIssues(found);
      return found;
    } catch {
      return null;
    }
  };

  const hasErrors = (found: FlowIssue[] | null) => !!found && found.some((i) => i.level === "error");

  const handleValidate = async () => {
    const found = await runValidation();
    if (found === null) message.error("Could not validate flow");
  };

  /** Saves nodes/edges. Returns whether it succeeded, so callers that must
   * not proceed on failure (e.g. `handleRun`) can bail out. */
  const handleSave = async (validateAfter = true): Promise<boolean> => {
    setSaving(true);
    try {
      await request(`/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify({ nodes, edges }),
      });
      message.success("Flow saved");
      if (validateAfter) await runValidation(); // advisory only: never blocks Save
      return true;
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save flow");
      return false;
    } finally {
      setSaving(false);
    }
  };

  // I1 fix: Run must reflect what's on the canvas right now, not the last
  // *saved* graph — save first (the same path the Save button uses) and
  // only open the drawer (which then runs the just-saved graph) if that
  // save succeeds. On failure, handleSave already showed the error; don't
  // open the drawer on top of it.
  const handleRun = async (mode: "run" | "dry-run" = "run") => {
    const saved = await handleSave(false); // Run validates once itself, below
    if (!saved) return;
    const found = await runValidation();
    if (hasErrors(found)) return;
    setDrawerMode(mode);
  };

  // I2 fix: browsing run history must never trigger a new real run — this
  // opens the drawer straight to its History tab with auto-run disabled
  // (see RunResultDrawer's `initialTab` prop), independent of the Run
  // button/save path above.
  const handleViewHistory = () => setDrawerMode("history");

  const handleNameBlur = async () => {
    const trimmed = flowName.trim();
    if (!trimmed) {
      setFlowName(savedName);
      return;
    }
    if (trimmed === savedName) return;
    try {
      await request(`/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      setSavedName(trimmed);
      setFlowName(trimmed);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to rename flow");
      setFlowName(savedName);
    }
  };

  const handleToggleStatus = async () => {
    const next = flowStatus === "active" ? "draft" : "active";
    if (next === "active") {
      const found = await runValidation();
      if (hasErrors(found)) return;
    }
    try {
      await request(`/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      setFlowStatus(next);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update flow status");
    }
  };

  const handleNodeConfigSave = useCallback((nodeId: string, config: FlowNodeConfig) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...(n.data as unknown as FlowNodeData), config } }
          : n,
      ),
    );
    setInspectorNode(null);
  }, []);

  if (loading) {
    return <Spin />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>
        <Input
          aria-label="Flow name"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          onBlur={() => void handleNameBlur()}
          style={{ width: 220 }}
          placeholder="Untitled flow"
        />
        <Dropdown menu={{ items: addNodeMenuItems, onClick: handleAddNode }}>
          <Button icon={<Plus size={14} />}>Add node</Button>
        </Dropdown>
        <Button icon={<SaveIcon size={14} />} loading={saving} onClick={() => void handleSave()}>
          Save
        </Button>
        <Button icon={<CheckCircle2 size={14} />} onClick={() => void handleValidate()}>
          Validate
        </Button>
        <Button
          icon={<Play size={14} />}
          aria-pressed={drawerMode === "run"}
          loading={saving}
          onClick={() => void handleRun()}
        >
          Run
        </Button>
        <Button
          icon={<FlaskConical size={14} />}
          aria-pressed={drawerMode === "dry-run"}
          loading={saving}
          onClick={() => void handleRun("dry-run")}
        >
          Dry run
        </Button>
        <Button
          icon={<History size={14} />}
          aria-pressed={drawerMode === "history"}
          onClick={handleViewHistory}
        >
          History
        </Button>
        <Tag color={flowStatus === "active" ? "green" : "default"}>
          {flowStatus === "active" ? "Active" : "Draft"}
        </Tag>
        <Button onClick={() => void handleToggleStatus()}>
          {flowStatus === "active" ? "Deactivate" : "Activate"}
        </Button>
      </div>
      {issues.length > 0 && (
        <Alert
          style={{ margin: "0 8px 8px" }}
          type={issues.some((i) => i.level === "error") ? "error" : "warning"}
          showIcon
          message={`${issues.filter((i) => i.level === "error").length} error(s), ${
            issues.filter((i) => i.level === "warning").length
          } warning(s)`}
          description={
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {issues.map((i, idx) => (
                <li
                  key={`${i.code}-${i.node_id ?? ""}-${idx}`}
                  data-level={i.level}
                  style={{ cursor: i.node_id ? "pointer" : "default", color: ISSUE_COLORS[i.level] }}
                  onClick={() => {
                    const target = i.node_id ? nodes.find((n) => n.id === i.node_id) : undefined;
                    if (target) setInspectorNode(target);
                  }}
                >
                  {i.message}
                </li>
              ))}
            </ul>
          }
        />
      )}
      <div style={{ flex: 1, minHeight: 480 }}>
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodesDraggable
          nodesConnectable={true}
          elementsSelectable
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls />
        </ReactFlow>
      </div>
      <NodeInspectorDrawer
        node={inspectorNode}
        open={inspectorNode !== null}
        onClose={() => setInspectorNode(null)}
        onSave={handleNodeConfigSave}
      />
      <RunResultDrawer
        flowId={flowId}
        open={drawerMode !== null}
        initialTab={drawerMode === "history" ? "history" : "run"}
        dryRun={drawerMode === "dry-run"}
        onClose={() => setDrawerMode(null)}
      />
    </div>
  );
}
