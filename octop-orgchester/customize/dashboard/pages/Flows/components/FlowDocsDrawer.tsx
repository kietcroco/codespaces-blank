import { useEffect, useState } from "react";
import { Button, Drawer, Input, Segmented, Space } from "antd";
import { message } from "@/utils/antdMessage";
import LazyMarkdown from "@/components/Markdown/LazyMarkdown";
import { apiErrorMessage } from "../../../utils/apiError";

/** Mirrors `DESCRIPTION_MAX_LENGTH` in backend/routers/flow.py. */
const DOCS_MAX_LENGTH = 20000;

/** Starter outline offered when the docs are empty. */
export const DOCS_TEMPLATE = "## Purpose\n\n## Trigger\n\n## Steps\n\n## Failure handling\n";

interface Props {
  open: boolean;
  description: string;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
}

/**
 * Edit / preview drawer for a flow's markdown documentation. The draft is
 * local state, reset from `description` every time the drawer opens, so
 * closing discards unsaved edits. Preview goes through LazyMarkdown only.
 */
export default function FlowDocsDrawer({ open, description, onClose, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState(description);
  const [mode, setMode] = useState<"Edit" | "Preview">("Edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(description);
      setMode("Edit");
      setError(null);
    }
    // Only a (re)open resets the draft; a description change while open must not clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      const text = apiErrorMessage(err, "Failed to save docs");
      setError(text);
      message.error(text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer title="Flow docs" open={open} onClose={onClose} width={480} destroyOnClose>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Segmented options={["Edit", "Preview"]} value={mode} onChange={(v) => setMode(v as "Edit" | "Preview")} />
        {mode === "Edit" ? (
          <>
            <Input.TextArea
              aria-label="Flow docs"
              value={draft}
              maxLength={DOCS_MAX_LENGTH}
              autoSize={{ minRows: 16 }}
              style={{ fontFamily: "monospace" }}
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft.trim() === "" && (
              <Button onClick={() => setDraft(DOCS_TEMPLATE)}>Use template</Button>
            )}
          </>
        ) : (
          <LazyMarkdown content={draft} />
        )}
        {error && <div role="alert" style={{ color: "#ef4444" }}>{error}</div>}
        <Space>
          <Button type="primary" loading={saving} disabled={draft === description} onClick={() => void handleSave()}>
            Save
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Space>
      </Space>
    </Drawer>
  );
}
