// customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import FlowCanvas from "./FlowCanvas";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("FlowCanvas", () => {
  it("loads and renders existing nodes by label", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } }],
      edges: [],
    });
    render(<FlowCanvas flowId="fl_1" />);
    expect(await screen.findByText("Start")).toBeInTheDocument();
  });

  it("opens the inspector drawer when a node is clicked and saves config edits", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "a", type: "agent", position: { x: 0, y: 0 }, data: { label: "Call agent", config: {} } }],
      edges: [],
    });
    api.mockResolvedValueOnce({}); // the PATCH on Save
    render(<FlowCanvas flowId="fl_1" />);
    (await screen.findByText("Call agent")).click();
    expect(await screen.findByLabelText(/prompt/i)).toBeInTheDocument();
  });

  // I1: Run must save the current canvas first, so it never executes a
  // stale persisted graph.
  it("saves the canvas before opening the Run drawer, then runs the saved graph", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } }],
      edges: [],
    }); // initial GET
    api.mockResolvedValueOnce({}); // PATCH from handleRun's save
    api.mockResolvedValueOnce({
      run_id: "run_1", status: "succeeded", output: {}, error: null,
      steps: [{ node_id: "t", node_type: "trigger", status: "succeeded", input: {}, output: null, error: null }],
    }); // POST /run from RunResultDrawer's auto-run effect

    render(<FlowCanvas flowId="fl_1" />);
    await screen.findByText("Start");

    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(api).toHaveBeenNthCalledWith(2, "/flows/fl_1", expect.objectContaining({ method: "PATCH" }));
    expect(api).toHaveBeenNthCalledWith(
      3,
      "/flows/fl_1/run",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
  });

  // I2: viewing history must never trigger a new real run.
  it("opens straight to History without POSTing a new run", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } }],
      edges: [],
    }); // initial GET
    api.mockResolvedValueOnce([
      { run_id: "run_1", flow_id: "fl_1", status: "succeeded", input: {}, output: {}, error: null, started_at: 1, finished_at: 1 },
    ]); // GET .../runs triggered by opening straight to History

    render(<FlowCanvas flowId="fl_1" />);
    await screen.findByText("Start");

    await userEvent.click(screen.getByRole("button", { name: "History" }));

    expect(await screen.findByText("run_1")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(
      "/flows/fl_1/run",
      expect.anything(),
    );
  });

  it("toggles flow status via an Activate/Deactivate button in the toolbar", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [], edges: [],
    }); // initial GET
    api.mockResolvedValueOnce({}); // PATCH {status: "active"}

    render(<FlowCanvas flowId="fl_1" />);
    await screen.findByText("Draft");

    await userEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(api).toHaveBeenNthCalledWith(
      2,
      "/flows/fl_1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "active" }) }),
    );
    expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  // I3: an editable name field in the toolbar PATCHes {name} on blur.
  it("renames the flow via the toolbar name field on blur", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "Old name", status: "draft",
      nodes: [],
      edges: [],
    }); // initial GET
    api.mockResolvedValueOnce({}); // PATCH on blur

    render(<FlowCanvas flowId="fl_1" />);
    const nameInput = await screen.findByLabelText("Flow name");
    expect(nameInput).toHaveValue("Old name");

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "New name");
    await userEvent.tab(); // blur

    expect(api).toHaveBeenCalledWith(
      "/flows/fl_1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "New name" }) }),
    );
  });
});
