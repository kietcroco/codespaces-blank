// customize/dashboard/pages/Flows/components/FlowDocsDrawer.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/Markdown/LazyMarkdown", () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));
import FlowDocsDrawer, { DOCS_TEMPLATE } from "./FlowDocsDrawer";

function setup(description: string, onSave = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  const utils = render(
    <FlowDocsDrawer open description={description} onClose={onClose} onSave={onSave} />,
  );
  return { ...utils, onSave, onClose };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("FlowDocsDrawer", () => {
  it("shows the saved text in a textarea capped at 20000 chars", () => {
    setup("# Hello");
    expect(textarea().value).toBe("# Hello");
    expect(textarea()).toHaveAttribute("maxlength", "20000");
  });

  it("offers the template only when the text is blank, and fills it", async () => {
    const { unmount } = setup("# Hello");
    expect(screen.queryByRole("button", { name: /use template/i })).toBeNull();
    unmount();
    setup("");
    await userEvent.click(screen.getByRole("button", { name: /use template/i }));
    expect(textarea().value).toBe(DOCS_TEMPLATE);
    expect(DOCS_TEMPLATE).toBe("## Purpose\n\n## Trigger\n\n## Steps\n\n## Failure handling\n");
  });

  it("previews through LazyMarkdown and never injects a script element", async () => {
    const text = "<script>alert(1)</script><b>x</b>";
    const { baseElement } = setup(text);
    await userEvent.click(screen.getByText("Preview"));
    expect(await screen.findByTestId("md")).toHaveTextContent(text);
    expect(baseElement.querySelector("script")).toBeNull();
    expect(baseElement.querySelector("b")).toBeNull();
  });

  it("enables Save only once the draft differs and saves the draft once", async () => {
    const { onSave } = setup("a");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(textarea(), "b");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("ab");
  });

  it("keeps the draft and shows an error when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const { onClose } = setup("a", onSave);
    await userEvent.type(textarea(), "b");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(textarea().value).toBe("ab");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("discards an unsaved draft when closed and re-opened", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(
      <FlowDocsDrawer open description="saved" onClose={onClose} onSave={onSave} />,
    );
    await userEvent.type(textarea(), " more");
    expect(textarea().value).toBe("saved more");
    rerender(<FlowDocsDrawer open={false} description="saved" onClose={onClose} onSave={onSave} />);
    rerender(<FlowDocsDrawer open description="saved" onClose={onClose} onSave={onSave} />);
    await waitFor(() => expect(textarea().value).toBe("saved"));
  });
});
