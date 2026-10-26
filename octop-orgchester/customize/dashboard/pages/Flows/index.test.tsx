// customize/dashboard/pages/Flows/index.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../api/request";
import FlowsPage from "./index";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("FlowsPage", () => {
  it("renders flow rows", async () => {
    api.mockResolvedValueOnce([
      { flow_id: "fl_1", name: "Lead triage", description: "d", status: "draft", created_at: 0, updated_at: 0 },
    ]);
    render(
      <MemoryRouter>
        <FlowsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Lead triage")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/flows");
  });

  it("shows empty state with 0 flows, no crash", async () => {
    api.mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <FlowsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/no flows yet/i)).toBeInTheDocument();
  });

  // I3: deleting a flow calls DELETE /flows/:id after confirm, then
  // refreshes the list.
  it("deletes a flow after confirm and refreshes the list", async () => {
    api.mockResolvedValueOnce([
      { flow_id: "fl_1", name: "Lead triage", description: "d", status: "draft", created_at: 0, updated_at: 0 },
    ]); // initial GET
    api.mockResolvedValueOnce(undefined); // DELETE -> 204/no body
    api.mockResolvedValueOnce([]); // reload GET after delete

    render(
      <MemoryRouter>
        <FlowsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Lead triage")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/flows/fl_1", { method: "DELETE" });
    });
    expect(await screen.findByText(/no flows yet/i)).toBeInTheDocument();
  });
});
