// customize/dashboard/pages/Flows/components/FlowVersionsDrawer.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import FlowVersionsDrawer, { type FlowVersionSummary } from "./FlowVersionsDrawer";
const api = vi.mocked(request, true);
beforeEach(() => api.mockReset());

const V3: FlowVersionSummary = { version_no: 3, label: "Release", kind: "manual", created_at: 1700000300, node_count: 4, edge_count: 3 };
const V2: FlowVersionSummary = { version_no: 2, label: null, kind: "auto", created_at: 1700000200, node_count: 2, edge_count: 1 };
const V1: FlowVersionSummary = { version_no: 1, label: "First", kind: "manual", created_at: 1700000100, node_count: 1, edge_count: 0 };

const posts = () =>
  api.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "POST");

function setup(over: Partial<{ saveBeforeSnapshot: () => Promise<boolean>; onRestored: () => void }> = {}) {
  const props = {
    saveBeforeSnapshot: vi.fn().mockResolvedValue(true),
    onRestored: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<FlowVersionsDrawer open flowId="f1" {...props} />);
  return props;
}

describe("FlowVersionsDrawer", () => {
  it("lists versions as returned with label, v<N>, auto tag and counts", async () => {
    api.mockResolvedValueOnce([V3, V2, V1]);
    setup();
    expect(await screen.findByText("Release")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/flows/f1/versions");
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(screen.getAllByText("auto")).toHaveLength(1);
    expect(screen.getByText(/4 nodes/)).toBeInTheDocument();
    expect(screen.getByText(/3 edges/)).toBeInTheDocument();
    const order = screen.getAllByText(/^v\d$/).map((e) => e.textContent);
    expect(order).toEqual(["v3", "v2", "v1"]);
  });

  it("shows an empty state", async () => {
    api.mockResolvedValueOnce([]);
    setup();
    expect(await screen.findByText("No versions yet")).toBeInTheDocument();
  });

  it("shows an error state when the list fails to load", async () => {
    api.mockRejectedValueOnce(new Error("load boom"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("load boom");
  });

  it("saves the canvas first, then POSTs the label and refreshes", async () => {
    const order: string[] = [];
    const saveBeforeSnapshot = vi.fn().mockImplementation(async () => {
      order.push("save");
      return true;
    });
    let created = false;
    api.mockImplementation((async (_path: string, opts?: { method?: string }) => {
      if (opts?.method === "POST") {
        order.push("post");
        created = true;
        return V1;
      }
      return created ? [V1] : [];
    }) as never);
    setup({ saveBeforeSnapshot });
    await screen.findByText("No versions yet");
    await userEvent.type(screen.getByLabelText("Version label"), "My label");
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(order).toEqual(["save", "post"]);
    expect(api).toHaveBeenCalledWith(
      "/flows/f1/versions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ label: "My label" }) }),
    );
  });

  it("sends label null when the label is empty", async () => {
    api.mockResolvedValue([] as never);
    setup();
    await screen.findByText("No versions yet");
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/flows/f1/versions",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ label: null }) }),
      ),
    );
  });

  it("does not POST when saving the canvas fails", async () => {
    api.mockResolvedValue([] as never);
    const saveBeforeSnapshot = vi.fn().mockResolvedValue(false);
    setup({ saveBeforeSnapshot });
    await screen.findByText("No versions yet");
    await userEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(saveBeforeSnapshot).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(0);
  });

  it("sends one POST on a double click", async () => {
    api.mockResolvedValue([] as never);
    let release: (v: boolean) => void = () => {};
    const saveBeforeSnapshot = vi.fn().mockImplementation(
      () => new Promise<boolean>((r) => { release = r; }),
    );
    setup({ saveBeforeSnapshot });
    await screen.findByText("No versions yet");
    await userEvent.dblClick(screen.getByRole("button", { name: "Save version" }));
    release(true);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(saveBeforeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("restores after a Popconfirm, then calls onRestored", async () => {
    api.mockResolvedValueOnce([V3]);
    const { onRestored } = setup();
    await screen.findByText("Release");
    api.mockResolvedValue({ flow: {}, restored_from: 3, backup_version_no: 4 } as never);
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText(/current canvas is replaced/i)).toBeInTheDocument();
    expect(screen.getByText(/backup is created automatically/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith("/flows/f1/versions/3/restore", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the drawer open and does not call onRestored when restore is rejected", async () => {
    api.mockResolvedValueOnce([V3]);
    const { onRestored, onClose } = setup();
    await screen.findByText("Release");
    api.mockRejectedValueOnce(new Error("restored version has 1 validation error(s): x"));
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("restored version has 1 validation error(s)");
    expect(onRestored).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Flow versions")).toBeInTheDocument();
  });
});
