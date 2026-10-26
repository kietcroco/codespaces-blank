import { useCallback, useEffect, useState } from "react";
import { Button, Card, Col, Empty, Popconfirm, Row, Spin } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { message } from "@/utils/antdMessage";
import { request } from "../../api/request";
import PageShell from "../../layouts/PageShell";

/** Flow row shape returned by GET/POST /flows (per backend/routers/flow.py). */
export interface FlowRow {
  flow_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active";
  created_at: number;
  updated_at: number;
}

/** One-line plain-text preview of a markdown description for the list cards. */
export function descriptionSummary(text: string | null | undefined, max = 140): string {
  if (!text) return "";
  const joined = text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:#+|[-*>]|\d+\.)\s*/, ""))
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

export default function FlowsPage(): JSX.Element {
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await request<FlowRow[]>("/flows");
      setFlows(rows);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load flows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await request<FlowRow>("/flows", {
        method: "POST",
        body: JSON.stringify({ name: "Untitled flow" }),
      });
      navigate(`/flows/${created.flow_id}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create flow");
    } finally {
      setCreating(false);
    }
  };

  // I3 fix: delete action, same Popconfirm shape as AgencyDetail.tsx's
  // "Delete this agency?" confirm — click events on the action are
  // stopped from bubbling to the Card's own onClick (which navigates).
  const handleDelete = async (flowId: string) => {
    setDeletingId(flowId);
    try {
      await request(`/flows/${flowId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete flow");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading && flows.length === 0) {
    return <Spin />;
  }

  return (
    <PageShell
      title="Flows"
      actions={
        <Button
          type="primary"
          icon={<Plus size={14} />}
          loading={creating}
          onClick={() => void handleCreate()}
        >
          New Flow
        </Button>
      }
    >
      {flows.length === 0 ? (
        <Empty description="No flows yet" />
      ) : (
        <Row gutter={[16, 16]}>
          {flows.map((flow) => (
            <Col key={flow.flow_id} xs={24} sm={12} md={8} lg={6}>
              <Card
                hoverable
                onClick={() => navigate(`/flows/${flow.flow_id}`)}
                title={flow.name}
                actions={[
                  <Popconfirm
                    key="delete"
                    title="Delete this flow?"
                    description="This cannot be undone."
                    okText="Yes, delete"
                    cancelText="Cancel"
                    okButtonProps={{ danger: true }}
                    onConfirm={(e) => {
                      e?.stopPropagation();
                      void handleDelete(flow.flow_id);
                    }}
                    onCancel={(e) => e?.stopPropagation()}
                  >
                    <Button
                      danger
                      type="text"
                      icon={<Trash2 size={14} />}
                      loading={deletingId === flow.flow_id}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Delete
                    </Button>
                  </Popconfirm>,
                ]}
              >
                {descriptionSummary(flow.description) && <p>{descriptionSummary(flow.description)}</p>}
                <p>{flow.status}</p>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </PageShell>
  );
}
