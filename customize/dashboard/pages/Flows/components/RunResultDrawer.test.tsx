// customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import RunResultDrawer from "./RunResultDrawer";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("RunResultDrawer", () => {
  it("triggers a run on open and shows each step's status", async () => {
    api.mockResolvedValueOnce({
      run_id: "run_1", status: "succeeded", output: {}, error: null,
      steps: [
        { node_id: "t", node_type: "trigger", status: "succeeded", input: {}, output: null, error: null },
        { node_id: "a", node_type: "agent", status: "succeeded", input: {}, output: { a_out: "hi" }, error: null, agent_id: "ag_1" },
      ],
    });
    render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/flows/fl_1/run", expect.objectContaining({ method: "POST" }));
  });

  it("shows a readable error for a failed step, not a crash", async () => {
    api.mockResolvedValueOnce({
      run_id: "run_2", status: "failed", output: {}, error: "exceeded max steps",
      steps: [{ node_id: "a", node_type: "agent", status: "failed", input: {}, output: null, error: "agent not found" }],
    });
    render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
    expect(await screen.findByText(/agent not found/i)).toBeInTheDocument();
  });

  it("shows the server's error message, not the raw request() error string, when a run fails", async () => {
    api.mockRejectedValueOnce(
      new Error('Request failed: 409 Conflict - {"error":{"code":"FLOW_NOT_ACTIVE","message":"flow must be active to run — activate it first","details":{}}}'),
    );
    render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
    expect(await screen.findByText("flow must be active to run — activate it first")).toBeInTheDocument();
  });

  // I2: initialTab="history" must open straight to History and never
  // auto-POST /run — the regression this drawer used to have (opening it
  // at all, for any reason, always triggered a fresh real run).
  it('with initialTab="history", loads history and never POSTs /run', async () => {
    api.mockResolvedValueOnce([
      { run_id: "run_3", flow_id: "fl_1", status: "succeeded", input: {}, output: {}, error: null, started_at: 1, finished_at: 1 },
    ]);
    render(<RunResultDrawer flowId="fl_1" open initialTab="history" onClose={() => {}} />);

    expect(await screen.findByText("run_3")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/flows/fl_1/runs");
    expect(api).not.toHaveBeenCalledWith(
      "/flows/fl_1/run",
      expect.anything(),
    );
  });
});
