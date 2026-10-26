import { useEffect, useState } from "react";
import { Button, Drawer, Form, Input, InputNumber, Select } from "antd";
import type { Node } from "@xyflow/react";
import { request } from "../../../api/request";
import type { OctopAgent } from "../../../context/AgentContext";
import type { FlowNodeConfig, FlowNodeData } from "./FlowCanvas";

const { TextArea } = Input;

const CONDITION_OPS: { value: NonNullable<FlowNodeConfig["op"]>; label: string }[] = [
  { value: "eq", label: "Equals" },
  { value: "neq", label: "Not equals" },
  { value: "gt", label: "Greater than" },
  { value: "lt", label: "Less than" },
  { value: "gte", label: "Greater or equal" },
  { value: "lte", label: "Less or equal" },
  { value: "contains", label: "Contains" },
];

export interface NodeInspectorDrawerProps {
  /** The clicked flow node, or `null` when the drawer is closed. */
  node: Node | null;
  open: boolean;
  onClose: () => void;
  /** Called with the node's id and the submitted config — persisted to
   * local state only; FlowCanvas's own "Save" button PATCHes the backend. */
  onSave: (nodeId: string, config: FlowNodeConfig) => void;
}

export default function NodeInspectorDrawer({
  node,
  open,
  onClose,
  onSave,
}: NodeInspectorDrawerProps): JSX.Element {
  const [form] = Form.useForm<FlowNodeConfig>();
  const [agents, setAgents] = useState<OctopAgent[]>([]);

  // Agent options are only needed for "agent" nodes — skip the fetch for
  // trigger/condition/end nodes entirely.
  useEffect(() => {
    if (!open || !node || node.type !== "agent") return;
    let active = true;
    (async () => {
      try {
        const rows = await request<OctopAgent[]>("/agents");
        if (active) setAgents(Array.isArray(rows) ? rows : []);
      } catch {
        if (active) setAgents([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, node]);

  useEffect(() => {
    if (!node) return;
    const data = node.data as unknown as FlowNodeData;
    form.setFieldsValue(data.config ?? {});
  }, [node, form]);

  const handleFinish = (values: FlowNodeConfig) => {
    if (!node) return;
    onSave(node.id, values);
  };

  const data = node?.data as unknown as FlowNodeData | undefined;

  return (
    <Drawer open={open} onClose={onClose} title={data?.label ?? "Node"} destroyOnClose>
      {node && (
        <Form form={form} layout="vertical" onFinish={handleFinish} initialValues={data?.config}>
          {node.type === "agent" && (
            <>
              <Form.Item name="agentId" label="Agent">
                <Select
                  options={agents.map((a) => ({ value: a.agent_id, label: a.name }))}
                  placeholder="Select an agent"
                  allowClear
                />
              </Form.Item>
              <Form.Item name="prompt" label="Prompt">
                <TextArea rows={4} />
              </Form.Item>
              <Form.Item name="outputVar" label="Output variable">
                <Input />
              </Form.Item>
              <Form.Item name="maxRetries" label="Max retries">
                <InputNumber min={0} max={5} precision={0} placeholder="0" style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="retryDelay" label="Retry delay (seconds)">
                <InputNumber min={0} max={30} step={0.5} placeholder="1" style={{ width: "100%" }} />
              </Form.Item>
            </>
          )}
          {node.type === "condition" && (
            <>
              <Form.Item name="left" label="Left">
                <Input />
              </Form.Item>
              <Form.Item name="op" label="Operator">
                <Select options={CONDITION_OPS} />
              </Form.Item>
              <Form.Item name="right" label="Right">
                <Input />
              </Form.Item>
            </>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit">
              Apply
            </Button>
          </Form.Item>
        </Form>
      )}
    </Drawer>
  );
}
