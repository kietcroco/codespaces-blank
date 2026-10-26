import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../api/request", () => ({ request: vi.fn() }));

import { request } from "../../../api/request";
import AgencyDetail from "./AgencyDetail";

const api = vi.mocked(request, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgencyDetail", () => {
  it("renders zero-member agency without dividing by zero or crashing", async () => {
    api.mockResolvedValueOnce({
      agency_id: "ag_1",
      name: "Ops",
      description: null,
      color: "#10B981",
      experts: [],
    });

    render(<AgencyDetail agencyId="ag_1" />);

    expect(await screen.findByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("0 experts")).toBeInTheDocument();
    expect(screen.getByText("No experts assigned yet")).toBeInTheDocument();
  });

  it("removing a member calls PUT .../members/{id} with agency_id: null", async () => {
    const detailWithMember = {
      agency_id: "ag_1",
      name: "Ops",
      description: null,
      color: "#10B981",
      experts: [
        { agent_id: "agent-1", name: "Bot", description: "Helper", status: "running" },
      ],
    };
    const detailEmpty = { ...detailWithMember, experts: [] };

    api.mockResolvedValueOnce(detailWithMember); // initial GET
    api.mockResolvedValueOnce({ expert_agent_id: "agent-1", agency_id: null }); // PUT
    api.mockResolvedValueOnce(detailEmpty); // reload GET after remove

    render(<AgencyDetail agencyId="ag_1" />);
    expect(await screen.findByText("Bot")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, remove" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/members/agent-1", {
        method: "PUT",
        body: JSON.stringify({ agency_id: null }),
      });
    });

    expect(await screen.findByText("No experts assigned yet")).toBeInTheDocument();
  });

  it("opens the edit modal pre-filled and PATCHes the agency on save", async () => {
    const detail = {
      agency_id: "ag_1",
      name: "Ops",
      description: "Operations department",
      color: "#10B981",
      experts: [],
    };

    api.mockResolvedValueOnce(detail); // initial GET
    api.mockResolvedValueOnce({ ...detail, name: "Ops Renamed", member_count: 0 }); // PATCH
    api.mockResolvedValueOnce({ ...detail, name: "Ops Renamed" }); // reload GET after save

    render(<AgencyDetail agencyId="ag_1" />);
    expect(await screen.findByText("Ops")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    const nameInput = await screen.findByLabelText("Name");
    expect(nameInput).toHaveValue("Ops");

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Ops Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/ag_1", {
        method: "PATCH",
        body: JSON.stringify({
          name: "Ops Renamed",
          description: "Operations department",
          color: "#10B981",
        }),
      });
    });

    expect(await screen.findByText("Ops Renamed")).toBeInTheDocument();
  });

  it("deletes the agency after confirm and calls onDeleted", async () => {
    const detail = {
      agency_id: "ag_1",
      name: "Ops",
      description: null,
      color: "#10B981",
      experts: [],
    };

    api.mockResolvedValueOnce(detail); // initial GET
    api.mockResolvedValueOnce(undefined); // DELETE -> 204/no body

    const onDeleted = vi.fn();
    render(<AgencyDetail agencyId="ag_1" onDeleted={onDeleted} />);
    expect(await screen.findByText("Ops")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/ag_1", { method: "DELETE" });
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("excludes experts the current user doesn't own from the Add-expert picker", async () => {
    const detail = {
      agency_id: "ag_1",
      name: "Ops",
      description: null,
      color: "#10B981",
      experts: [],
    };
    api.mockResolvedValueOnce(detail); // initial GET
    api.mockResolvedValueOnce([
      { agent_id: "mine", name: "Mine", description: null, color: null, is_owner: true },
      {
        agent_id: "theirs",
        name: "Theirs",
        description: null,
        color: null,
        is_owner: false,
        is_shared: true,
      },
    ]); // GET /agents

    render(<AgencyDetail agencyId="ag_1" />);
    expect(await screen.findByText("Ops")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add expert" }));

    expect(await screen.findByText("Mine")).toBeInTheDocument();
    expect(screen.queryByText("Theirs")).not.toBeInTheDocument();
  });

  it("reloads the member list even when adding a selected expert fails", async () => {
    const detail = {
      agency_id: "ag_1",
      name: "Ops",
      description: null,
      color: "#10B981",
      experts: [],
    };
    const detailAfter = {
      ...detail,
      experts: [{ agent_id: "mine", name: "Mine", description: null, status: "running" }],
    };
    api.mockResolvedValueOnce(detail); // initial GET
    api.mockResolvedValueOnce([
      { agent_id: "mine", name: "Mine", description: null, color: null, is_owner: true },
    ]); // GET /agents
    api.mockRejectedValueOnce(new Error("boom")); // PUT members/mine fails
    api.mockResolvedValueOnce(detailAfter); // reload GET — must still happen

    render(<AgencyDetail agencyId="ag_1" />);
    expect(await screen.findByText("Ops")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add expert" }));
    await userEvent.click(await screen.findByText("Mine"));
    await userEvent.click(screen.getByRole("button", { name: "Add (1)" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/ag_1");
    });
  });
});
