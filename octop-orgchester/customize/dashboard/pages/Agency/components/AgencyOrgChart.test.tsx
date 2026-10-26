import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../api/request", () => ({ request: vi.fn() }));

import { request } from "../../../api/request";
import AgencyOrgChart from "./AgencyOrgChart";

const api = vi.mocked(request, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgencyOrgChart", () => {
  it("lays out agencies and experts without framer-motion, no crash on empty agencies array", async () => {
    api.mockResolvedValueOnce({ agencies: [] });

    render(<AgencyOrgChart />);

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/org-chart");
    });

    expect(screen.queryByTestId("org-chart-connector")).not.toBeInTheDocument();
  });

  it("draws one connector per agency-expert pair", async () => {
    api.mockResolvedValueOnce({
      agencies: [
        {
          agency_id: "ag_1",
          name: "Sales",
          color: "#3B3BFF",
          experts: [
            { agent_id: "a1", name: "Bot One", description: "Helper one", status: "active" },
            { agent_id: "a2", name: "Bot Two", description: "Helper two", status: "draft" },
          ],
        },
      ],
    });

    render(<AgencyOrgChart />);

    expect(await screen.findByText("Sales")).toBeInTheDocument();
    expect(await screen.findByText("Bot One")).toBeInTheDocument();
    expect(await screen.findByText("Bot Two")).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.getAllByTestId("org-chart-connector")).toHaveLength(2);
      },
      { timeout: 2000 },
    );
  });
});
