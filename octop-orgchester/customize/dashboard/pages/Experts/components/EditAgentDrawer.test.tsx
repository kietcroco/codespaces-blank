import { forwardRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, Form } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The global setup mock recreates `t` on every call, unlike the real
// react-i18next hook (stable reference) — EditAgentDrawer's load effect
// depends on `t`, so a fresh `t` each render retriggers it forever. Pin a
// stable `t` (created once, at module scope) so the effect only reruns
// when agent/form actually change.
vi.mock("react-i18next", () => {
  type TOptions = Record<string, unknown> & { defaultValue?: string };
  const interpolate = (template: string, options?: TOptions): string => {
    if (!options) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in options ? String(options[name]) : match,
    );
  };
  const t = (
    key: string,
    fallback?: string | TOptions,
    options?: TOptions,
  ): string => {
    if (typeof fallback === "string") return interpolate(fallback, options);
    if (fallback && typeof fallback === "object") {
      const template = fallback.defaultValue ?? key;
      return interpolate(template, fallback);
    }
    return key;
  };
  const i18n = { language: "zh", changeLanguage: () => Promise.resolve() };
  return {
    useTranslation: () => ({ t, i18n }),
    Trans: ({ children }: { children?: React.ReactNode }) => children,
  };
});

vi.mock("../../../api/request", () => ({ request: vi.fn() }));
vi.mock("../../../hooks/useAgentFormResources", () => ({
  useAgentFormResources: () => ({
    models: [],
    modelsLoading: false,
    backends: [],
    backendsLoading: false,
  }),
}));
vi.mock("../../../context/AgentContext", () => ({
  useAgent: () => ({ refresh: vi.fn() }),
}));
vi.mock("../../../api/modules/workspace", () => ({
  workspaceApi: { readWorkspaceFile: vi.fn(), createWorkspaceFile: vi.fn() },
}));
vi.mock("../../../api/modules/skillPackages", () => ({
  skillPackagesApi: { replaceMounted: vi.fn() },
}));
vi.mock("../../../api/modules/octopAgents", () => ({
  octopAgentsApi: { uploadAvatar: vi.fn(), deleteAvatar: vi.fn() },
}));
vi.mock("./ExpertAvatarPicker", () => ({ default: () => null }));
vi.mock("../../../components/ExpertColorPicker", () => ({
  default: () => null,
}));
// Real AgentBackendFields registers backend_choice/composite_default/root_dir
// as Form.Items; handleSave's buildBackendSpec() reads them from validateFields()
// and crashes on undefined, so the stand-in must still register them (hidden).
vi.mock("./AgentBackendFields", () => ({
  default: () => (
    <>
      <Form.Item name="backend_choice" noStyle>
        <input type="hidden" />
      </Form.Item>
      <Form.Item name="composite_default" noStyle>
        <input type="hidden" />
      </Form.Item>
      <Form.Item name="root_dir" noStyle>
        <input type="hidden" />
      </Form.Item>
    </>
  ),
}));
vi.mock("./ExpertComposerDefaultsFields", () => ({ default: () => null }));
vi.mock("./WelcomeConfig", () => ({ default: forwardRef(() => null) }));
vi.mock("./FileEditModal", () => ({ default: () => null }));
vi.mock("../../Agent/Workspace/components/WorkspaceDrawer", () => ({
  default: () => null,
}));
vi.mock("./SkillCatalogDrawer", () => ({ default: () => null }));
vi.mock("./SubagentCatalogDrawer", () => ({ default: () => null }));
vi.mock("./EditExpertDrawerTitle", () => ({ default: () => null }));
vi.mock("../../../components/AgentAdvancedConfigFields", () => ({
  AgentAdvancedConfigFields: () => null,
}));
vi.mock("../../Agent/Skills/skillDisplayNames", () => ({
  useSkillDisplayName: () => (x: string) => x,
}));
vi.mock("../../Agent/Skills/skillMarkdown", () => ({
  DEFAULT_SKILL_EMOJI: "🙂",
}));
vi.mock("./agentBackendForm", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agentBackendForm")>();
  return { ...actual, shouldProbeRootDir: () => false };
});

import { request } from "../../../api/request";
import EditAgentDrawer from "./EditAgentDrawer";
import type { OctopAgent } from "../../../context/AgentContext";

const api = vi.mocked(request, true);

const AGENT: OctopAgent = {
  id: 1,
  agent_id: "agent1",
  name: "Doctor",
  description: null,
  persona_mbti: null,
  default_model: null,
  system_prompt: null,
  template_name: null,
  state: "stopped",
  last_error: null,
  icon: null,
  icon_name: null,
  icon_url: null,
  color: null,
  config: {},
};

const AGENCIES = [
  { agency_id: "ag_1", name: "Sales", description: null, color: "#3B3BFF", member_count: 0 },
  { agency_id: "ag_2", name: "Ops", description: null, color: "#10B981", member_count: 1 },
];

function renderDrawer() {
  return render(
    <App>
      <EditAgentDrawer
        open
        agent={AGENT}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </App>,
  );
}

let orgChartResponse: {
  agencies: { agency_id: string; name: string; color: string | null; experts: { agent_id: string }[] }[];
} = { agencies: [] };
let membersPutImpl: () => Promise<unknown> = async () => ({ ok: true });

beforeEach(() => {
  vi.clearAllMocks();
  orgChartResponse = { agencies: [] };
  membersPutImpl = async () => ({ ok: true });
  api.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === "/agencies") return AGENCIES;
    if (url === "/agencies/org-chart") return orgChartResponse;
    if (url === "/agents/agent1" && !opts) {
      return {
        id: "agent1",
        name: "Doctor",
        description: "",
        default_model: null,
        config: {},
      };
    }
    if (url === "/agents/agent1" && opts?.method === "PATCH") return {};
    if (url.startsWith("/agencies/members/")) return membersPutImpl();
    return undefined;
  });
});

describe("EditAgentDrawer agency picker", () => {
  it("changing the Agency select calls PUT /agencies/members/{id} after a successful save", async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByLabelText("Agency")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Agency"));
    await userEvent.click(await screen.findByText("Ops"));

    await userEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/members/agent1", {
        method: "PUT",
        body: JSON.stringify({ agency_id: "ag_2" }),
      });
    });
  });

  it("does not call PUT /agencies/members when the Agency select is left untouched", async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByLabelText("Agency")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        "/agents/agent1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });

    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining("/agencies/members/"),
      expect.anything(),
    );
  });

  it("preselects the expert's current Agency from the org-chart, without marking the field touched", async () => {
    orgChartResponse = {
      agencies: [
        { agency_id: "ag_2", name: "Ops", color: "#10B981", experts: [{ agent_id: "agent1" }] },
      ],
    };
    renderDrawer();

    await waitFor(() => expect(screen.getByText("Ops")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        "/agents/agent1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    // Preselecting is not the same as the user touching the field — an
    // untouched preselected value must not re-PUT the same membership.
    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining("/agencies/members/"),
      expect.anything(),
    );
  });

  it("still completes the save (onSaved/onClose called) when the Agency PUT fails", async () => {
    membersPutImpl = async () => {
      throw new Error("boom");
    };
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <App>
        <EditAgentDrawer open agent={AGENT} onClose={onClose} onSaved={onSaved} />
      </App>,
    );

    await waitFor(() => expect(screen.getByLabelText("Agency")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Agency"));
    await userEvent.click(await screen.findByText("Ops"));
    await userEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
