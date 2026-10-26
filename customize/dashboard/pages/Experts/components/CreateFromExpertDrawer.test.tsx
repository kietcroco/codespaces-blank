import { forwardRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable `t` (created once, at module scope) instead of the global setup
// mock's per-call-new-function version — this component's effects don't
// depend on `t`, but keeping the identity stable avoids the same class of
// render-storm risk seen in EditAgentDrawer's test.
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

vi.mock("@/utils/antdMessage", () => ({
  message: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
vi.mock("../../../hooks/useAgentFormResources", () => ({
  useAgentFormResources: () => ({
    models: [{ provider_name: "openai", model: "gpt-4" }],
    modelsLoading: false,
    backends: [],
    backendsLoading: false,
  }),
}));
vi.mock("../../../api/modules/skillPackages", () => ({
  skillPackagesApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../../api/modules/octopAgents", () => ({
  octopAgentsApi: { uploadAvatar: vi.fn(), deleteAvatar: vi.fn() },
}));
vi.mock("./ExpertAvatarPicker", () => ({ default: () => null }));
// Real AgentBackendFields registers backend_choice/composite_default/root_dir
// as Form.Items; handleCreate's buildBackendSpec() reads them from
// validateFields() and crashes on undefined, so the stand-in must still
// register them (hidden).
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
vi.mock("./SkillSourcePickerModal", () => ({ default: () => null }));
vi.mock("./SubagentSourcePickerModal", () => ({ default: () => null }));
vi.mock("../../../components/AgentAdvancedConfigFields", () => ({
  AgentAdvancedConfigFields: () => null,
}));
vi.mock("./agentBackendForm", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agentBackendForm")>();
  return { ...actual, shouldProbeRootDir: () => false };
});

import { request } from "../../../api/request";
import CreateFromExpertDrawer, {
  type CreateFromTemplateSource,
} from "./CreateFromExpertDrawer";

const api = vi.mocked(request, true);

const SOURCE: CreateFromTemplateSource = {
  kind: "builtin",
  expert: {
    id: "doctor",
    label: { en: "Doctor" },
    description: { en: "A doctor" },
    icon_name: null,
    icon_url: null,
    color: null,
  },
};

const AGENCIES = [
  { agency_id: "ag_1", name: "Sales", description: null, color: "#3B3BFF", member_count: 0 },
  { agency_id: "ag_2", name: "Ops", description: null, color: "#10B981", member_count: 1 },
];

function renderDrawer() {
  return render(
    <CreateFromExpertDrawer
      open
      source={SOURCE}
      lang="en"
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === "/agencies") return AGENCIES;
    if (url === "/experts/doctor") return { file_contents: [], quick_prompts: [] };
    if (url === "/agents/from-expert/doctor" && opts?.method === "POST") {
      return { agent_id: "agent_new", name: "Doctor" };
    }
    if (url.startsWith("/agencies/members/")) return { ok: true };
    return undefined;
  });
});

describe("CreateFromExpertDrawer agency picker", () => {
  it("picking an Agency before create calls PUT /agencies/members/{id} with the new agent_id after a successful POST", async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByLabelText("Agency")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Agency"));
    await userEvent.click(await screen.findByText("Ops"));

    await userEvent.click(screen.getByRole("button", { name: "common.create" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/agencies/members/agent_new", {
        method: "PUT",
        body: JSON.stringify({ agency_id: "ag_2" }),
      });
    });
  });

  it("does not call PUT /agencies/members when no Agency is picked", async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByLabelText("Agency")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "common.create" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        "/agents/from-expert/doctor",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining("/agencies/members/"),
      expect.anything(),
    );
  });
});
