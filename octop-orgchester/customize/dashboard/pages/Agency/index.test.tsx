import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/request", () => ({ request: vi.fn() }));

import { request } from "../../api/request";
import AgencyPage from "./index";

const api = vi.mocked(request, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgencyPage", () => {
  it("renders agency cards with member counts", async () => {
    api.mockResolvedValueOnce([
      {
        agency_id: "ag_1",
        name: "Sales",
        description: "Revenue team",
        color: "#3B3BFF",
        member_count: 3,
      },
      {
        agency_id: "ag_2",
        name: "Ops",
        description: null,
        color: "#10B981",
        member_count: 0,
      },
    ]);

    render(<AgencyPage />);

    expect(await screen.findByText("Sales")).toBeInTheDocument();
    expect(screen.getByText("3 experts")).toBeInTheDocument();
    expect(screen.getByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("0 experts")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/agencies");
  });

  it("shows empty state with 0 agencies, no crash", async () => {
    api.mockResolvedValueOnce([]);

    render(<AgencyPage />);

    expect(await screen.findByText("No agencies yet")).toBeInTheDocument();
  });
});
