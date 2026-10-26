// customize/dashboard/pages/Flows/flowTemplates.test.ts
import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES } from "./flowTemplates";

type N = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: { label: string; config: Record<string, unknown> };
};
type E = { id: string; source: string; target: string; sourceHandle?: string | null };

/** Small static validator: returns issue strings for a built graph. */
function validate(nodes: N[], edges: E[]): string[] {
  const issues: string[] = [];
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) issues.push("duplicate node ids");
  if (nodes.filter((n) => n.type === "trigger").length !== 1) issues.push("need exactly one trigger");
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) issues.push(`edge ${e.id} endpoint missing`);
  }
  for (const n of nodes) {
    const out = edges.filter((e) => e.source === n.id);
    if (n.type === "condition") {
      for (const e of out) if (e.sourceHandle !== "true" && e.sourceHandle !== "false") issues.push("bad handle");
    }
    if (n.type === "agent") {
      if (String(n.data.config.prompt ?? "").trim() === "") issues.push("blank prompt");
      if (!n.data.config.agentId) issues.push("agent has no agentId");
    }
  }
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const state = new Map<string, number>();
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    for (const t of adj.get(id) ?? []) {
      if (state.get(t) === 1) return true;
      if (!state.has(t) && dfs(t)) return true;
    }
    state.set(id, 2);
    return false;
  };
  const trigger = nodes.find((n) => n.type === "trigger");
  if (trigger) {
    if (dfs(trigger.id)) issues.push("cycle");
    for (const n of nodes) if (!state.has(n.id)) issues.push(`unreachable ${n.id}`);
  }
  return issues;
}

const byId = (id: string) => {
  const t = FLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const built = (id: string) => byId(id).build() as unknown as { nodes: N[]; edges: E[] };
const nodeOf = (nodes: N[], id: string) => nodes.find((n) => n.id === id)!;

describe("FLOW_TEMPLATES", () => {
  it("has the three templates in order with exact ids and names", () => {
    expect(FLOW_TEMPLATES.map((t) => [t.id, t.name])).toEqual([
      ["ask-agent", "Ask an agent"],
      ["branch-on-reply", "Branch on a reply"],
      ["two-step-pipeline", "Two-step pipeline"],
    ]);
  });

  it.each(["ask-agent", "branch-on-reply", "two-step-pipeline"])(
    "%s is a valid graph except unselected agents",
    (id) => {
      const { nodes, edges } = built(id);
      const agents = nodes.filter((n) => n.type === "agent").length;
      expect(validate(nodes, edges)).toEqual(Array(agents).fill("agent has no agentId"));
      for (const n of nodes) {
        expect(n.id).toMatch(new RegExp(`^${n.type}_\\d+$`));
        expect(Object.keys(n).sort()).toEqual(["data", "id", "position", "type"]);
        expect(Object.keys(n.data).sort()).toEqual(["config", "label"]);
      }
      for (const e of edges) {
        expect(e.id).toBe(`e_${e.source}_${e.target}${e.sourceHandle ? `_${e.sourceHandle}` : ""}`);
        if (nodeOf(nodes, e.source).type !== "condition") expect("sourceHandle" in e).toBe(false);
      }
    },
  );

  it("agentId key is absent from every agent config", () => {
    for (const t of FLOW_TEMPLATES) {
      for (const n of t.build().nodes as unknown as N[]) {
        if (n.type === "agent") expect("agentId" in n.data.config).toBe(false);
      }
    }
  });

  it("ask-agent: trigger -> agent -> end with exact config", () => {
    const { nodes, edges } = built("ask-agent");
    expect(nodes.map((n) => n.id)).toEqual(["trigger_1", "agent_1", "end_1"]);
    expect(nodeOf(nodes, "agent_1").data.config).toEqual({ prompt: "{{question}}", outputVar: "answer" });
    expect(edges.map((e) => e.id)).toEqual(["e_trigger_1_agent_1", "e_agent_1_end_1"]);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 80, y: 0 },
      { x: 80, y: 120 },
      { x: 80, y: 240 },
    ]);
  });

  it("branch-on-reply: exact prompts, condition triple and handle routing", () => {
    const { nodes, edges } = built("branch-on-reply");
    const agents = nodes.filter((n) => n.type === "agent");
    expect(agents.map((n) => [n.data.label, n.data.config])).toEqual([
      ["Agent", { prompt: "Answer only yes or no: {{question}}", outputVar: "verdict" }],
      ["Yes handler", { prompt: "The answer was yes. Continue with: {{question}}", outputVar: "yes_result" }],
      ["No handler", { prompt: "The answer was no. Explain why for: {{question}}", outputVar: "no_result" }],
    ]);
    const cond = nodes.find((n) => n.type === "condition")!;
    expect(cond.data.config).toEqual({ left: "{{verdict|trim|lower}}", op: "contains", right: "yes" });
    const from = edges.filter((e) => e.source === cond.id);
    const yes = from.find((e) => e.sourceHandle === "true")!;
    const no = from.find((e) => e.sourceHandle === "false")!;
    expect(from).toHaveLength(2);
    expect(nodeOf(nodes, yes.target).data.label).toBe("Yes handler");
    expect(nodeOf(nodes, no.target).data.label).toBe("No handler");
    expect(yes.id).toBe(`e_${cond.id}_${yes.target}_true`);
    expect(nodes.filter((n) => n.type === "end")).toHaveLength(1);
    const end = nodes.find((n) => n.type === "end")!;
    expect(edges.filter((e) => e.target === end.id).map((e) => e.source).sort()).toEqual(
      [yes.target, no.target].sort(),
    );
    expect([yes.target, no.target].map((id) => nodeOf(nodes, id).position.x)).toEqual([0, 260]);
  });

  it("two-step-pipeline: exact prompts and order", () => {
    const { nodes, edges } = built("two-step-pipeline");
    const agents = nodes.filter((n) => n.type === "agent");
    expect(agents.map((n) => [n.data.label, n.data.config])).toEqual([
      ["Summarize", { prompt: "Summarize in 3 bullets: {{text}}", outputVar: "summary" }],
      ["Rewrite", { prompt: "Rewrite for a customer email: {{summary|truncate:500}}", outputVar: "email" }],
    ]);
    expect(edges.map((e) => [e.source, e.target])).toEqual([
      ["trigger_1", "agent_1"],
      ["agent_1", "agent_2"],
      ["agent_2", "end_1"],
    ]);
  });

  it("description has four sections and is short; summary is one short sentence", () => {
    for (const t of FLOW_TEMPLATES) {
      for (const h of ["## Purpose", "## Trigger", "## Steps", "## Failure handling"]) {
        expect(t.description).toContain(h);
      }
      expect(t.description.length).toBeLessThanOrEqual(600);
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeLessThanOrEqual(100);
      expect(t.summary).not.toContain("\n");
    }
    expect(byId("ask-agent").description).toContain("question");
    expect(byId("branch-on-reply").description).toContain("question");
    expect(byId("two-step-pipeline").description).toContain("text");
  });

  it("build() returns equal but distinct objects each call", () => {
    for (const t of FLOW_TEMPLATES) {
      const a = t.build();
      const b = t.build();
      expect(a).toEqual(b);
      expect(a.nodes).not.toBe(b.nodes);
      expect(a.nodes[0]).not.toBe(b.nodes[0]);
      expect(a.nodes[0].data).not.toBe(b.nodes[0].data);
      (a.nodes[0].data as { label: string }).label = "mutated";
      expect((t.build().nodes[0].data as { label: string }).label).not.toBe("mutated");
    }
  });

  it("uses only trim, lower and truncate filters", () => {
    const allowed = new Set(["trim", "lower", "truncate"]);
    for (const t of FLOW_TEMPLATES) {
      for (const n of t.build().nodes as unknown as N[]) {
        for (const v of Object.values(n.data.config)) {
          if (typeof v !== "string") continue;
          for (const m of v.matchAll(/\{\{([^}]*)\}\}/g)) {
            for (const f of m[1].split("|").slice(1)) expect(allowed.has(f.split(":")[0].trim())).toBe(true);
          }
        }
      }
    }
  });
});
