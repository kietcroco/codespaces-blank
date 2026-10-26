// customize/dashboard/pages/Flows/index.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../api/request";
import FlowsPage, { descriptionSummary } from "./index";
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

  it("renders only the summary of a long markdown description on the card", async () => {
    const long = "# Title\n- " + "word ".repeat(100);
    api.mockResolvedValueOnce([
      { flow_id: "fl_1", name: "Lead triage", description: long, status: "draft", created_at: 0, updated_at: 0 },
    ]);
    render(
      <MemoryRouter>
        <FlowsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(descriptionSummary(long))).toBeInTheDocument();
    expect(screen.queryByText(/# Title/)).toBeNull();
  });
});

describe("descriptionSummary", () => {
  it("returns empty for null, undefined and blank", () => {
    expect(descriptionSummary(null)).toBe("");
    expect(descriptionSummary(undefined)).toBe("");
    expect(descriptionSummary("  \n \n")).toBe("");
  });
  it("strips heading, bullet, quote and numbering markers", () => {
    expect(descriptionSummary("# Title\n- one\n* two\n> three\n1. four")).toBe("Title one two three four");
  });
  it("joins lines with single spaces", () => {
    expect(descriptionSummary("a   b\n\n c")).toBe("a b c");
  });
  it("truncates long text with an ellipsis", () => {
    expect(descriptionSummary("x".repeat(300))).toBe("x".repeat(140) + "\u2026");
    expect(descriptionSummary("abcdef", 3)).toBe("abc\u2026");
  });
});
