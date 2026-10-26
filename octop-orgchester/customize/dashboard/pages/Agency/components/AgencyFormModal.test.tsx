import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../api/request", () => ({ request: vi.fn() }));

import { request } from "../../../api/request";
import AgencyFormModal from "./AgencyFormModal";

const api = vi.mocked(request, true);

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue({
    agency_id: "ag_new",
    name: "Sales",
    description: "Revenue team",
    color: "#10B981",
    member_count: 0,
  });
});

describe("AgencyFormModal", () => {
  it("submits name/description/color on save", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<AgencyFormModal open onClose={onClose} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText("Name"), "Sales");
    await userEvent.type(screen.getByLabelText("Description"), "Revenue team");
    await userEvent.click(screen.getByRole("button", { name: "color-#10B981" }));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies", {
        method: "POST",
        body: JSON.stringify({
          name: "Sales",
          description: "Revenue team",
          color: "#10B981",
        }),
      });
    });
    expect(onSaved).toHaveBeenCalledWith({
      agency_id: "ag_new",
      name: "Sales",
      description: "Revenue team",
      color: "#10B981",
      member_count: 0,
    });
  });

  it("PATCHes when an agencyId is passed instead of POSTing", async () => {
    const onSaved = vi.fn();
    render(
      <AgencyFormModal
        open
        agencyId="ag_1"
        initialValues={{ name: "Ops", description: "", color: "#3B3BFF" }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/ag_1", {
        method: "PATCH",
        body: JSON.stringify({
          name: "Ops",
          description: null,
          color: "#3B3BFF",
        }),
      });
    });
  });
});
