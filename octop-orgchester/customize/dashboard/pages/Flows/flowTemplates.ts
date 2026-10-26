// customize/dashboard/pages/Flows/flowTemplates.ts
import type { Edge, Node } from "@xyflow/react";

export interface FlowTemplate {
  id: string;
  name: string;
  summary: string;
  description: string;
  build: () => { nodes: Node[]; edges: Edge[] };
}

type Cfg = Record<string, unknown>;

// Agent nodes deliberately carry no agentId: the user picks the agent on the canvas.
const node = (id: string, type: string, label: string, x: number, y: number, config: Cfg = {}): Node => ({
  id,
  type,
  position: { x, y },
  data: { label, config },
});

const edge = (source: string, target: string, sourceHandle?: "true" | "false"): Edge => ({
  id: `e_${source}_${target}${sourceHandle ? `_${sourceHandle}` : ""}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "ask-agent",
    name: "Ask an agent",
    summary: "Send a question to one agent and return its answer.",
    description: [
      "## Purpose",
      "Ask one agent a question and return its answer.",
      "",
      "## Trigger",
      "Run with the input variable `question` (the text to ask).",
      "",
      "## Steps",
      "1. The agent answers `{{question}}`; the reply is stored as `answer`.",
      "2. The flow ends.",
      "",
      "## Failure handling",
      "Pick an agent on the Agent node before activating. If the agent fails, the run stops at that step and shows the error.",
    ].join("\n"),
    build: () => ({
      nodes: [
        node("trigger_1", "trigger", "Trigger", 80, 0),
        node("agent_1", "agent", "Agent", 80, 120, { prompt: "{{question}}", outputVar: "answer" }),
        node("end_1", "end", "End", 80, 240),
      ],
      edges: [edge("trigger_1", "agent_1"), edge("agent_1", "end_1")],
    }),
  },
  {
    id: "branch-on-reply",
    name: "Branch on a reply",
    summary: "Ask a yes/no question, then take a different path for each answer.",
    description: [
      "## Purpose",
      "Ask an agent a yes/no question and handle each answer differently.",
      "",
      "## Trigger",
      "Run with the input variable `question`.",
      "",
      "## Steps",
      "1. The first agent answers yes or no (`verdict`).",
      "2. A condition checks whether the verdict contains \"yes\".",
      "3. True goes to the Yes handler, false to the No handler.",
      "4. Both paths end the flow.",
      "",
      "## Failure handling",
      "Pick an agent on every Agent node before activating. A failed step stops the run and shows the error.",
    ].join("\n"),
    build: () => ({
      nodes: [
        node("trigger_1", "trigger", "Trigger", 80, 0),
        node("agent_1", "agent", "Agent", 80, 120, {
          prompt: "Answer only yes or no: {{question}}",
          outputVar: "verdict",
        }),
        node("condition_1", "condition", "Condition", 80, 240, {
          left: "{{verdict|trim|lower}}",
          op: "contains",
          right: "yes",
        }),
        node("agent_2", "agent", "Yes handler", 0, 360, {
          prompt: "The answer was yes. Continue with: {{question}}",
          outputVar: "yes_result",
        }),
        node("agent_3", "agent", "No handler", 260, 360, {
          prompt: "The answer was no. Explain why for: {{question}}",
          outputVar: "no_result",
        }),
        node("end_1", "end", "End", 80, 480),
      ],
      edges: [
        edge("trigger_1", "agent_1"),
        edge("agent_1", "condition_1"),
        edge("condition_1", "agent_2", "true"),
        edge("condition_1", "agent_3", "false"),
        edge("agent_2", "end_1"),
        edge("agent_3", "end_1"),
      ],
    }),
  },
  {
    id: "two-step-pipeline",
    name: "Two-step pipeline",
    summary: "Summarize some text, then rewrite the summary as a customer email.",
    description: [
      "## Purpose",
      "Turn raw text into a short customer email in two steps.",
      "",
      "## Trigger",
      "Run with the input variable `text` (the content to summarize).",
      "",
      "## Steps",
      "1. Summarize: an agent writes 3 bullets (`summary`).",
      "2. Rewrite: an agent turns the summary into an email (`email`).",
      "3. The flow ends.",
      "",
      "## Failure handling",
      "Pick an agent on both Agent nodes before activating. If a step fails, later steps do not run.",
    ].join("\n"),
    build: () => ({
      nodes: [
        node("trigger_1", "trigger", "Trigger", 80, 0),
        node("agent_1", "agent", "Summarize", 80, 120, {
          prompt: "Summarize in 3 bullets: {{text}}",
          outputVar: "summary",
        }),
        node("agent_2", "agent", "Rewrite", 80, 240, {
          prompt: "Rewrite for a customer email: {{summary|truncate:500}}",
          outputVar: "email",
        }),
        node("end_1", "end", "End", 80, 360),
      ],
      edges: [edge("trigger_1", "agent_1"), edge("agent_1", "agent_2"), edge("agent_2", "end_1")],
    }),
  },
];
