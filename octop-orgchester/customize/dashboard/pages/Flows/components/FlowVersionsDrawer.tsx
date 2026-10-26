import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Input, List, Popconfirm, Space, Tag } from "antd";
import { message } from "@/utils/antdMessage";
import { request } from "../../../api/request";
import { apiErrorMessage } from "../../../utils/apiError";

/** Mirrors `LABEL_MAX_LENGTH` in backend/routers/flow.py. */
const LABEL_MAX_LENGTH = 100;

/** One row of `GET /flows/:flowId/versions` (no graph payload). */
export interface FlowVersionSummary {
  version_no: number;
  label: string | null;
  kind: "manual" | "auto";
  created_at: number;
  node_count: number;
  edge_count: number;
}

interface Props {
  open: boolean;
  flowId: string;
  onClose: () => void;
  /** Persist the canvas first; resolves false when that save failed. */
  saveBeforeSnapshot: () => Promise<boolean>;
  /** Called after a successful restore so the canvas can reload the graph. */
  onRestored: () => Promise<void> | void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Drawer listing a flow's saved versions: save the current canvas as a new
 * version (optionally labelled) and restore any earlier one. A busy ref guards
 * against double submission; errors keep the drawer open.
 */
export default function FlowVersionsDrawer({
  open,
  flowId,
  onClose,
  saveBeforeSnapshot,
  onRestored,
}: Props): JSX.Element {
  const [versions, setVersions] = useState<FlowVersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoringNo, setRestoringNo] = useState<number | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await request<FlowVersionSummary[]>(`/flows/${flowId}/versions`);
      setVersions(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "Failed to load versions"));
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (open) {
      setActionError(null);
      void refresh();
    }
  }, [open, refresh]);

  const handleSaveVersion = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setActionError(null);
    try {
      const saved = await saveBeforeSnapshot();
      if (!saved) return;
      const trimmed = label.trim();
      await request(`/flows/${flowId}/versions`, {
        method: "POST",
        body: JSON.stringify({ label: trimmed === "" ? null : trimmed }),
      });
      setLabel("");
      message.success("Version saved");
      await refresh();
    } catch (err) {
      const text = apiErrorMessage(err, "Failed to save version");
      setActionError(text);
      message.error(text);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const handleRestore = async (versionNo: number) => {
    if (busy.current) return;
    busy.current = true;
    setRestoringNo(versionNo);
    setActionError(null);
    try {
      await request(`/flows/${flowId}/versions/${versionNo}/restore`, { method: "POST" });
    } catch (err) {
      const text = apiErrorMessage(err, "Failed to restore version");
      setActionError(text);
      message.error(text);
      busy.current = false;
      setRestoringNo(null);
      return;
    }
    try {
      try {
        await onRestored();
        message.success(`Restored v${versionNo}`);
      } catch (err) {
        const text = apiErrorMessage(err, "Restored, but failed to reload the canvas; reopen the flow");
        setActionError(text);
        message.error(text);
      }
      await refresh();
    } finally {
      busy.current = false;
      setRestoringNo(null);
    }
  };

  return (
    <Drawer title="Flow versions" open={open} onClose={onClose} width={480} destroyOnClose>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            aria-label="Version label"
            placeholder="Label (optional)"
            value={label}
            maxLength={LABEL_MAX_LENGTH}
            onChange={(e) => setLabel(e.target.value)}
            onPressEnter={() => void handleSaveVersion()}
          />
          <Button type="primary" loading={saving} onClick={() => void handleSaveVersion()}>
            Save version
          </Button>
        </Space.Compact>
        {loadError && <Alert type="error" showIcon role="alert" message={loadError} />}
        {actionError && <Alert type="error" showIcon role="alert" message={actionError} />}
        {!loadError && (
          <List
            loading={loading}
            dataSource={versions}
            locale={{ emptyText: "No versions yet" }}
            renderItem={(v) => (
              <List.Item
                key={v.version_no}
                actions={[
                  <Popconfirm
                    key="restore"
                    title={`Restore v${v.version_no}?`}
                    description="The current canvas is replaced; a backup is created automatically."
                    okText="Yes, restore"
                    cancelText="Cancel"
                    onConfirm={() => void handleRestore(v.version_no)}
                  >
                    <Button size="small" loading={restoringNo === v.version_no}>
                      Restore
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={4}>
                      <span>{v.label ?? "Untitled"}</span>
                      <Tag>{`v${v.version_no}`}</Tag>
                      {v.kind === "auto" && <Tag color="default">auto</Tag>}
                    </Space>
                  }
                  description={`${plural(v.node_count, "node")}, ${plural(v.edge_count, "edge")} - ${new Date(
                    v.created_at * 1000,
                  ).toLocaleString()}`}
                />
              </List.Item>
            )}
          />
        )}
      </Space>
    </Drawer>
  );
}
