// customize/dashboard/pages/Flows/index.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../api/request";
import FlowsPage, { descriptionSummary } from "./index";
import { FLOW_TEMPLATES } from "./flowTemplates";
const api = vi.mocked(request, true);
const navigateMock = vi.hoisted(() => vi.fn());
const messageError = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));
vi.mock("@/utils/antdMessage", () => ({ message: { error: messageError, success: vi.fn() } }));
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

describe("FlowsPage templates", () => {
  const renderPage = () =>
    render(
      <MemoryRouter>
        <FlowsPage />
      </MemoryRouter>,
    );
  const openAndUseFirst = async () => {
    await userEvent.click(await screen.findByRole("button", { name: /from template/i }));
    await userEvent.click((await screen.findAllByRole("button", { name: "Use" }))[0]);
  };

  it("New Flow makes exactly one POST /flows and navigates", async () => {
    api.mockResolvedValueOnce([]); // GET
    api.mockResolvedValueOnce({ flow_id: "fl_9" }); // POST
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /new flow/i }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/flows/fl_9"));
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith("/flows", {
      method: "POST",
      body: JSON.stringify({ name: "Untitled flow" }),
    });
  });

  it("From template opens a modal listing the three templates", async () => {
    api.mockResolvedValueOnce([]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /from template/i }));
    for (const t of FLOW_TEMPLATES) {
      expect(await screen.findByText(t.name)).toBeInTheDocument();
      expect(screen.getByText(t.summary)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: "Use" })).toHaveLength(3);
  });

  it("Use creates the flow, patches nodes/edges, then navigates", async () => {
    api.mockResolvedValueOnce([]);
    api.mockResolvedValueOnce({ flow_id: "fl_7" });
    api.mockResolvedValueOnce({ flow_id: "fl_7" });
    renderPage();
    await openAndUseFirst();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/flows/fl_7"));
    const t = FLOW_TEMPLATES[0];
    expect(api).toHaveBeenCalledTimes(3);
    expect(api).toHaveBeenNthCalledWith(2, "/flows", {
      method: "POST",
      body: JSON.stringify({ name: t.name, description: t.description }),
    });
    const [path, init] = api.mock.calls[2] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/flows/fl_7");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["edges", "nodes"]);
    expect(body).toEqual(JSON.parse(JSON.stringify(t.build())));
  });

  it("PATCH failure shows the error and still navigates", async () => {
    api.mockResolvedValueOnce([]);
    api.mockResolvedValueOnce({ flow_id: "fl_7" });
    api.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    await openAndUseFirst();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/flows/fl_7"));
    expect(messageError).toHaveBeenCalledTimes(1);
  });

  it("POST failure shows the error, no PATCH, no navigation", async () => {
    api.mockResolvedValueOnce([]);
    api.mockRejectedValueOnce(new Error("nope"));
    renderPage();
    await openAndUseFirst();
    await waitFor(() => expect(messageError).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(2);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("a second click on Use while creating makes no second POST", async () => {
    api.mockResolvedValueOnce([]);
    let resolvePost: (v: unknown) => void = () => {};
    api.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePost = r;
        }),
    );
    api.mockResolvedValueOnce({ flow_id: "fl_7" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /from template/i }));
    const uses = await screen.findAllByRole("button", { name: "Use" });
    await userEvent.click(uses[0]);
    await userEvent.click(uses[0]);
    await userEvent.click(uses[1]);
    expect(api).toHaveBeenCalledTimes(2);
    resolvePost({ flow_id: "fl_7" });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/flows/fl_7"));
    expect(api).toHaveBeenCalledTimes(3);
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
