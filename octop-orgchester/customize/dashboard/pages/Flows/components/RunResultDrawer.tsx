import { useCallback, useEffect, useState } from "react";
import { Drawer, Tabs, List, Tag, Typography, Empty, Spin } from "antd";
import { message } from "@/utils/antdMessage";
import { request } from "../../../api/request";
import { apiErrorMessage } from "../../../utils/apiError";

const { Text } = Typography;

/**
 * Same green/amber/gray dot convention as `AgencyOrgChart.tsx`'s
 * `STATUS_DOT` (6x6 circle, `#52525b` fallback) — a run step only ever
 * lands on "succeeded" or "failed" (see `backend/flows/engine.py`'s
 * `StepResult.status` / `FlowRunResult.status`), so this just adds the red
 * `"failed"` entry that chart didn't need.
 */
const STATUS_DOT: Record<string, string> = {
  succeeded: "#34d399",
  failed: "#f87171",
};

export interface FlowRunStep {
  node_id: string;
  node_type: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  agent_id?: string | null;
}

/** Shape of `POST /flows/:flowId/run`'s response. */
export interface FlowRunResult {
  /** `null` for a dry run - nothing is persisted. */
  run_id: string | null;
  dry_run?: boolean;
  status: string;
  output: unknown;
  error: string | null;
  steps: FlowRunStep[];
}

/** One row of `GET /flows/:flowId/runs` (no `steps` — that needs the detail call). */
export interface FlowRunSummary {
  run_id: string;
  flow_id: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

/** Shape of `GET /flows/:flowId/runs/:runId`. */
export interface FlowRunDetail extends FlowRunSummary {
  steps: FlowRunStep[];
}

/** Keeps a step's `output`/`error` from blowing up the drawer's layout. */
function truncate(value: unknown, max = 160): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function StatusDot({ status }: { status: string }): JSX.Element {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        flexShrink: 0,
        borderRadius: "50%",
        display: "inline-block",
        marginRight: 8,
        backgroundColor: STATUS_DOT[status] ?? "#52525b",
      }}
    />
  );
}

function StepList({ steps }: { steps: FlowRunStep[] }): JSX.Element {
  if (!steps.length) {
    return <Empty description="No steps" />;
  }
  return (
    <List
      size="small"
      dataSource={steps}
      rowKey="node_id"
      renderItem={(step) => (
        <List.Item>
          <List.Item.Meta
            title={
              <span>
                <StatusDot status={step.status} />
                {step.node_id}
              </span>
            }
            description={
              step.error ? (
                <Text type="danger">{truncate(step.error)}</Text>
              ) : (
                truncate(step.output)
              )
            }
          />
        </List.Item>
      )}
    />
  );
}

export interface RunResultDrawerProps {
  flowId: string;
  open: boolean;
  onClose: () => void;
  /**
   * "run" (default): auto-POSTs `/run` as soon as the drawer opens, same
   * as before. "history": opens straight to the History tab and never
   * auto-POSTs a run — I2 fix, so browsing past runs doesn't itself add a
   * new row to the history being browsed. `FlowCanvas.tsx`'s separate
   * "Run"/"History" toolbar buttons set this.
   */
  initialTab?: "run" | "history";
  /** Sends `dry_run: true` with the run (nothing persisted, agents not called). */
  dryRun?: boolean;
}

export default function RunResultDrawer({
  flowId,
  open,
  onClose,
  initialTab = "run",
  dryRun = false,
}: RunResultDrawerProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FlowRunResult | null>(null);

  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<FlowRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Kick off a fresh run each time the drawer opens — but only when it was
  // opened to run (initialTab "run"). Opened to browse history, this must
  // stay a no-op: that's the whole point of I2's fix.
  useEffect(() => {
    if (!open || initialTab !== "run") return;
    let active = true;
    setRunning(true);
    setResult(null);
    setHistoryLoaded(false);
    setHistory([]);
    setSelectedRun(null);
    setSelectedRunId(null);
    (async () => {
      try {
        const data = await request<FlowRunResult>(`/flows/${flowId}/run`, {
          method: "POST",
          body: JSON.stringify(dryRun ? { input: {}, dry_run: true } : { input: {} }),
        });
        if (active) setResult(data);
      } catch (err) {
        if (active) {
          message.error(apiErrorMessage(err, "Failed to run flow"));
        }
      } finally {
        if (active) setRunning(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, flowId, initialTab, dryRun]);

  const loadHistory = useCallback(() => {
    if (historyLoaded || historyLoading) return;
    setHistoryLoading(true);
    (async () => {
      try {
        const rows = await request<FlowRunSummary[]>(`/flows/${flowId}/runs`);
        setHistory(Array.isArray(rows) ? rows : []);
      } catch {
        setHistory([]);
      } finally {
        setHistoryLoaded(true);
        setHistoryLoading(false);
      }
    })();
  }, [flowId, historyLoaded, historyLoading]);

  // Opened straight to History (no auto-run above): load it immediately
  // instead of waiting for a manual Tabs click, since the Run tab's effect
  // that would otherwise populate state is intentionally skipped.
  useEffect(() => {
    if (open && initialTab === "history") loadHistory();
  }, [open, initialTab, loadHistory]);

  const loadRunDetail = (runId: string) => {
    setSelectedRunId(runId);
    (async () => {
      try {
        const detail = await request<FlowRunDetail>(
          `/flows/${flowId}/runs/${runId}`,
        );
        setSelectedRun(detail);
      } catch {
        setSelectedRun(null);
      }
    })();
  };

  const runPane = running ? (
    <Spin />
  ) : result ? (
    <>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <Tag color={STATUS_DOT[result.status] ?? "#52525b"}>{result.status}</Tag>
        {result.dry_run && <Tag>dry run</Tag>}
        {result.error && <Text type="danger">{truncate(result.error)}</Text>}
      </div>
      <StepList steps={result.steps} />
    </>
  ) : (
    <Empty description="No run yet" />
  );

  const historyPane = (
    <div style={{ display: "flex", gap: 16 }}>
      <List
        size="small"
        style={{ flex: 1, minWidth: 0 }}
        loading={historyLoading}
        dataSource={history}
        rowKey="run_id"
        locale={{ emptyText: historyLoaded ? "No runs yet" : " " }}
        renderItem={(run) => (
          <List.Item
            onClick={() => loadRunDetail(run.run_id)}
            style={{
              cursor: "pointer",
              fontWeight: run.run_id === selectedRunId ? 600 : undefined,
            }}
          >
            <List.Item.Meta
              title={
                <span>
                  <StatusDot status={run.status} />
                  {run.run_id}
                </span>
              }
              description={`${run.status} · ${run.started_at}`}
            />
          </List.Item>
        )}
      />
      {selectedRunId && (
        <div style={{ flex: 1, minWidth: 0 }}>
          {selectedRun ? <StepList steps={selectedRun.steps} /> : <Spin />}
        </div>
      )}
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} title={dryRun ? "Dry run" : "Run flow"} width={480} destroyOnClose>
      <Tabs
        defaultActiveKey={initialTab}
        onChange={(key) => {
          if (key === "history") loadHistory();
        }}
        items={[
          { key: "run", label: "Run", children: runPane },
          { key: "history", label: "History", children: historyPane },
        ]}
      />
    </Drawer>
  );
}
