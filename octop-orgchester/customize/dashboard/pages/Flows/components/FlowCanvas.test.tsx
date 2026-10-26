// customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
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
    api.mockResolvedValueOnce({ valid: true, issues: [] }); // POST /validate
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
      "/flows/fl_1/validate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(api).toHaveBeenNthCalledWith(
      4,
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
    api.mockResolvedValueOnce({ valid: true, issues: [] }); // POST /validate
    api.mockResolvedValueOnce({}); // PATCH {status: "active"}

    render(<FlowCanvas flowId="fl_1" />);
    await screen.findByText("Draft");

    await userEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(api).toHaveBeenNthCalledWith(
      3,
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

describe("FlowCanvas validation", () => {
  const AGENT = { id: "a", type: "agent", position: { x: 0, y: 0 }, data: { label: "Call agent", config: {} } };
  const ERR = { level: "error", code: "agent_missing_agent", message: "Agent node a has no agent selected.", node_id: "a" };
  const WARN = { level: "warning", code: "unreachable_node", message: "Node a is not reachable.", node_id: "a" };

  /** Routes the mocked request by URL; `validate` may be a value or a rejection. */
  function setup(validate: unknown | Error, status = "draft") {
    api.mockImplementation((async (url: string, init?: { method?: string }) => {
      if (url === "/flows/f1" && !init) return { flow_id: "f1", name: "F", status, nodes: [AGENT], edges: [] };
      if (url === "/flows/f1/validate") {
        if (validate instanceof Error) throw validate;
        return validate;
      }
      if (url === "/flows/f1/run") return { run_id: "r", status: "succeeded", output: {}, error: null, steps: [] };
      return {};
    }) as never);
  }
  const calls = (pred: (url: string, init?: { method?: string; body?: string }) => boolean) =>
    api.mock.calls.filter(([u, i]) => pred(u as string, i as never));
  const isActivate = (u: string, i?: { method?: string; body?: string }) =>
    u === "/flows/f1" && i?.method === "PATCH" && !!i.body && JSON.parse(i.body).status === "active";

  it("shows issues returned by Validate", async () => {
    setup({ valid: false, issues: [ERR, WARN] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Validate" }));
    const e = await screen.findByText(ERR.message);
    const w = await screen.findByText(WARN.message);
    expect(e.closest("[data-level]")).toHaveAttribute("data-level", "error");
    expect(w.closest("[data-level]")).toHaveAttribute("data-level", "warning");
    const [, init] = calls((u) => u === "/flows/f1/validate")[0];
    expect((init as { method: string }).method).toBe("POST");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.nodes[0].id).toBe("a");
    expect(body.edges).toEqual([]);
  });

  it("blocks Activate when validation has errors", async () => {
    setup({ valid: false, issues: [ERR] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByText(ERR.message)).toBeInTheDocument();
    expect(calls(isActivate)).toHaveLength(0);
  });

  it("Activate proceeds when only warnings", async () => {
    setup({ valid: true, issues: [WARN] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(calls(isActivate)).toHaveLength(1);
  });

  it("Run does not open the result drawer when validation has errors", async () => {
    setup({ valid: false, issues: [ERR] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(ERR.message)).toBeInTheDocument();
    expect(calls((u) => u === "/flows/f1/run")).toHaveLength(0);
  });

  const runBodies = () =>
    calls((u) => u === "/flows/f1/run").map(([, i]) => JSON.parse((i as { body: string }).body));

  it("Dry run saves, validates, then opens the drawer in dry-run mode (draft flow)", async () => {
    setup({ valid: true, issues: [] }, "draft");
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(runBodies()).toHaveLength(1));
    expect(runBodies()[0]).toEqual({ input: {}, dry_run: true });
    expect(calls((u, i) => u === "/flows/f1" && i?.method === "PATCH")).toHaveLength(1);
    expect(calls((u) => u === "/flows/f1/validate")).toHaveLength(1);
  });

  it("Dry run does not POST /run when validation has errors", async () => {
    setup({ valid: false, issues: [ERR] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Dry run" }));
    expect(await screen.findByText(ERR.message)).toBeInTheDocument();
    expect(calls((u) => u === "/flows/f1/run")).toHaveLength(0);
  });

  it("normal Run still POSTs /run without dry_run", async () => {
    setup({ valid: true, issues: [] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runBodies()).toHaveLength(1));
    expect(runBodies()[0]).toEqual({ input: {} });
  });

  it("fails open when validate request errors", async () => {
    setup(new Error("network"));
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(calls(isActivate)).toHaveLength(1);
  });

  it("clicking an issue with a node_id opens that node's inspector", async () => {
    setup({ valid: false, issues: [ERR] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Validate" }));
    await userEvent.click(await screen.findByText(ERR.message));
    expect(await screen.findByLabelText(/prompt/i)).toBeInTheDocument();
  });

  it("never persists the outline style on saved nodes", async () => {
    setup({ valid: false, issues: [ERR] });
    render(<FlowCanvas flowId="f1" />);
    await screen.findByText("Call agent");
    await userEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText(ERR.message);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const patch = calls((u, i) => u === "/flows/f1" && i?.method === "PATCH")[0];
    const body = JSON.parse((patch[1] as { body: string }).body);
    expect(body.nodes[0]).not.toHaveProperty("style");
  });
});
