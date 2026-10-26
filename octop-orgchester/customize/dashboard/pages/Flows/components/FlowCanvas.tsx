import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { Button, Dropdown, Input, Spin, Tag, type MenuProps } from "antd";
import { History, Play, Plus, Save as SaveIcon } from "lucide-react";
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
  const [drawerMode, setDrawerMode] = useState<"run" | "history" | null>(null);
  const [inspectorNode, setInspectorNode] = useState<Node | null>(null);

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

  /** Saves nodes/edges. Returns whether it succeeded, so callers that must
   * not proceed on failure (e.g. `handleRun`) can bail out. */
  const handleSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await request(`/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify({ nodes, edges }),
      });
      message.success("Flow saved");
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
  const handleRun = async () => {
    const saved = await handleSave();
    if (saved) setDrawerMode("run");
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
        <Button
          icon={<Play size={14} />}
          aria-pressed={drawerMode === "run"}
          loading={saving}
          onClick={() => void handleRun()}
        >
          Run
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
      <div style={{ flex: 1, minHeight: 480 }}>
        <ReactFlow
          nodes={nodes}
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
        onClose={() => setDrawerMode(null)}
      />
    </div>
  );
}
