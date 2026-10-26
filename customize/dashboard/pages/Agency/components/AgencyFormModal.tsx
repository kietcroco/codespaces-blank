import { useEffect } from "react";
import { Form, Input, Modal } from "antd";
import { message } from "@/utils/antdMessage";
import { request } from "../../../api/request";

/** Agency row shape returned by GET/POST/PATCH /api/agencies (per backend/routers/agency.py). */
export interface AgencyRow {
  agency_id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  member_count: number;
}

/** Swatch palette — mirrors orchester's TeamFormModal.tsx color choices (reference only, no shared code). */
export const AGENCY_COLORS = [
  "#7C3AED",
  "#3B3BFF",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#EC4899",
  "#6366F1",
];

export interface AgencyFormInitialValues {
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface AgencyFormModalProps {
  open: boolean;
  /** Present → PATCH an existing agency; absent → POST a new one. */
  agencyId?: string;
  initialValues?: AgencyFormInitialValues;
  onClose: () => void;
  onSaved: (row: AgencyRow) => void;
}

interface AgencyFormValues {
  name: string;
  description?: string;
  color: string;
}

interface ColorSwatchPickerProps {
  value?: string;
  onChange?: (color: string) => void;
}

function ColorSwatchPicker({ value, onChange }: ColorSwatchPickerProps) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {AGENCY_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`color-${color}`}
          aria-pressed={value === color}
          onClick={() => onChange?.(color)}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: color,
            border: value === color ? "2px solid #262626" : "1px solid #d9d9d9",
            cursor: "pointer",
            padding: 0,
          }}
        />
      ))}
    </div>
  );
}

export default function AgencyFormModal({
  open,
  agencyId,
  initialValues,
  onClose,
  onSaved,
}: AgencyFormModalProps) {
  const [form] = Form.useForm<AgencyFormValues>();
  const isEdit = Boolean(agencyId);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: initialValues?.name ?? "",
      description: initialValues?.description ?? "",
      color: initialValues?.color ?? AGENCY_COLORS[0],
    });
  }, [open, initialValues, form]);

  const handleOk = async () => {
    let values: AgencyFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // antd already renders the inline field errors.
      return;
    }

    const body = {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      color: values.color,
    };

    try {
      const saved = isEdit
        ? await request<AgencyRow>(`/agencies/${encodeURIComponent(agencyId!)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : await request<AgencyRow>("/agencies", {
            method: "POST",
            body: JSON.stringify(body),
          });
      form.resetFields();
      onSaved(saved);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save agency");
    }
  };

  return (
    <Modal
      title={isEdit ? "Edit agency" : "New agency"}
      open={open}
      onCancel={onClose}
      onOk={() => void handleOk()}
      okText="Save"
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          label="Name"
          name="name"
          rules={[{ required: true, message: "Name is required" }]}
        >
          <Input placeholder="e.g. Sales" />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} placeholder="What does this agency do?" />
        </Form.Item>
        <Form.Item label="Color" name="color">
          <ColorSwatchPicker />
        </Form.Item>
      </Form>
    </Modal>
  );
}
