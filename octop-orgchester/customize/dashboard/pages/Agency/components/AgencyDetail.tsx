import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Drawer,
  Empty,
  List,
  Popconfirm,
  Spin,
  Tag,
  Typography,
} from "antd";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { message } from "@/utils/antdMessage";
import { request } from "../../../api/request";
import type { OctopAgent } from "../../../context/AgentContext";
import { isOwnedExpert } from "../../../utils/sharedExpert";
import TeamMemberPicker, {
  type TeamMemberOption,
} from "../../Experts/components/TeamMemberPicker";
import AgencyFormModal, { type AgencyRow } from "./AgencyFormModal";

const { Title, Text } = Typography;

/** One assigned expert, per GET /api/agencies/{id}'s `experts` array. */
export interface AgencyExpert {
  agent_id: string;
  name: string;
  description: string | null;
  status: string;
}

/** Full detail payload for GET /api/agencies/{id}. */
export interface AgencyDetailResponse {
  agency_id: string;
  name: string;
  description: string | null;
  color: string | null;
  experts: AgencyExpert[];
}

export interface AgencyDetailProps {
  agencyId: string;
  /** Called after a successful delete, so the caller can close/navigate away. */
  onDeleted?: () => void;
}

/**
 * Adapts a full `OctopAgent` (from `GET /agents`) into the shape
 * `TeamMemberPicker` expects. Every field it reads (`kind`, `is_owner`,
 * `is_shared`, `bridge`) is already present on `OctopAgent` — no faking
 * required, see the reuse decision in the Task 4 report.
 */
function toMemberOption(agent: OctopAgent): TeamMemberOption {
  return {
    agent_id: agent.agent_id,
    name: agent.name,
    description: agent.description,
    color: agent.color,
    icon_name: agent.icon_name,
    icon_url: agent.icon_url,
    kind: agent.kind,
    is_shared: agent.is_shared,
    is_owner: agent.is_owner,
    bridge: agent.bridge,
  };
}

export default function AgencyDetail({ agencyId, onDeleted }: AgencyDetailProps) {
  const [detail, setDetail] = useState<AgencyDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<OctopAgent[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await request<AgencyDetailResponse>(
        `/agencies/${encodeURIComponent(agencyId)}`,
      );
      setDetail(row);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load agency");
    } finally {
      setLoading(false);
    }
  }, [agencyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const experts = detail?.experts ?? [];
  const memberIds = useMemo(() => new Set(experts.map((e) => e.agent_id)), [experts]);

  const handleRemove = async (expertAgentId: string) => {
    setRemovingId(expertAgentId);
    try {
      await request(`/agencies/members/${encodeURIComponent(expertAgentId)}`, {
        method: "PUT",
        body: JSON.stringify({ agency_id: null }),
      });
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to remove expert");
    } finally {
      setRemovingId(null);
    }
  };

  const openPicker = async () => {
    setPicked([]);
    setPickerOpen(true);
    try {
      const agents = await request<OctopAgent[]>("/agents");
      // set_member_agency always 403s a non-owned expert — unlike Team
      // rosters, Agency has no "shared expert" exception (spec §3: an
      // Agency's members belong to the same owner as the Agency itself).
      // TeamMemberPicker's own isPickableExpert() would let shared-but-
      // foreign experts through, so filter to owned ones before handing
      // candidates to it.
      setCandidates(
        agents.filter(
          (agent) => isOwnedExpert(agent) && !memberIds.has(agent.agent_id),
        ),
      );
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load experts");
    }
  };

  const handleAddSelected = async () => {
    if (picked.length === 0) return;
    setAdding(true);
    try {
      for (const expertAgentId of picked) {
        await request(`/agencies/members/${encodeURIComponent(expertAgentId)}`, {
          method: "PUT",
          body: JSON.stringify({ agency_id: agencyId }),
        });
      }
      setPickerOpen(false);
      setPicked([]);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to add expert");
    } finally {
      setAdding(false);
      // Reload even on partial failure — a 403 partway through the loop
      // still committed the earlier PUTs; the list must reflect that
      // rather than silently going stale.
      await load();
    }
  };

  const handleDeleteAgency = async () => {
    setDeleting(true);
    try {
      await request(`/agencies/${encodeURIComponent(agencyId)}`, {
        method: "DELETE",
      });
      onDeleted?.();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete agency");
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !detail) {
    return <Spin />;
  }
  if (!detail) {
    return <Empty description="Agency not found" />;
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div>
          <Title level={4} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Tag color={detail.color ?? undefined}>{detail.name}</Tag>
          </Title>
          {detail.description && <Text type="secondary">{detail.description}</Text>}
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <Button icon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Popconfirm
            title="Delete this agency?"
            description="Its experts will be unassigned, not deleted."
            okText="Yes, delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDeleteAgency()}
          >
            <Button danger icon={<Trash2 size={14} />} loading={deleting}>
              Delete
            </Button>
          </Popconfirm>
        </div>
      </div>

      <div style={{ margin: "12px 0" }}>
        <Button icon={<Plus size={14} />} onClick={() => void openPicker()}>
          Add expert
        </Button>
      </div>

      <div style={{ marginBottom: 8 }}>
        <Text type="secondary">
          {experts.length} expert{experts.length === 1 ? "" : "s"}
        </Text>
      </div>

      {experts.length === 0 ? (
        <Empty description="No experts assigned yet" />
      ) : (
        <List
          dataSource={experts}
          rowKey="agent_id"
          renderItem={(expert) => (
            <List.Item
              actions={[
                <Popconfirm
                  key="remove"
                  title="Remove this expert from the agency?"
                  description="They'll be unassigned, not deleted."
                  okText="Yes, remove"
                  cancelText="Cancel"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleRemove(expert.agent_id)}
                >
                  <Button
                    danger
                    type="text"
                    loading={removingId === expert.agent_id}
                  >
                    Remove
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={<Avatar>{expert.name.slice(0, 1).toUpperCase()}</Avatar>}
                title={expert.name}
                description={expert.description || " "}
              />
              <Tag>{expert.status}</Tag>
            </List.Item>
          )}
        />
      )}

      <Drawer
        title="Add expert to this agency"
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        width={420}
        extra={
          <Button
            type="primary"
            loading={adding}
            disabled={picked.length === 0}
            onClick={() => void handleAddSelected()}
          >
            Add{picked.length > 0 ? ` (${picked.length})` : ""}
          </Button>
        }
      >
        <TeamMemberPicker
          value={picked}
          onChange={setPicked}
          experts={candidates.map(toMemberOption)}
        />
      </Drawer>

      <AgencyFormModal
        open={editOpen}
        agencyId={agencyId}
        initialValues={{
          name: detail.name,
          description: detail.description,
          color: detail.color,
        }}
        onClose={() => setEditOpen(false)}
        onSaved={(_row: AgencyRow) => {
          setEditOpen(false);
          void load();
        }}
      />
    </div>
  );
}
