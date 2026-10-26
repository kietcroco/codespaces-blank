// customize/dashboard/pages/Flows/components/NodeInspectorDrawer.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import NodeInspectorDrawer from "./NodeInspectorDrawer";
const api = vi.mocked(request, true);
beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue([]);
});

const agentNode = {
  id: "n1",
  type: "agent",
  position: { x: 0, y: 0 },
  data: { label: "Agent", config: { maxRetries: 2, retryDelay: 1.5 } },
} as unknown as Node;

const conditionNode = {
  id: "n2",
  type: "condition",
  position: { x: 0, y: 0 },
  data: { label: "Cond", config: {} },
} as unknown as Node;

describe("NodeInspectorDrawer retry fields", () => {
  it("shows retry fields for agent nodes with saved values", async () => {
    render(<NodeInspectorDrawer node={agentNode} open onClose={() => {}} onSave={() => {}} />);
    expect(await screen.findByLabelText("Max retries")).toHaveValue("2");
    expect(screen.getByLabelText("Retry delay (seconds)")).toHaveValue("1.5");
  });

  it("submits retry values in the saved config", async () => {
    const onSave = vi.fn();
    render(<NodeInspectorDrawer node={agentNode} open onClose={() => {}} onSave={onSave} />);
    const input = await screen.findByLabelText("Max retries");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "n1",
        expect.objectContaining({ maxRetries: 3, retryDelay: 1.5 }),
      ),
    );
  });

  it("does not render retry fields for condition nodes", async () => {
    render(<NodeInspectorDrawer node={conditionNode} open onClose={() => {}} onSave={() => {}} />);
    await screen.findByText("Operator");
    expect(screen.queryByLabelText("Max retries")).toBeNull();
    expect(screen.queryByLabelText("Retry delay (seconds)")).toBeNull();
  });
});
