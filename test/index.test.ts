import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piLazy, { replaceEditorIfUnchanged } from "../src/index.js";

describe("piLazy", () => {
  it("registers only the /lazy command", () => {
    const registerCommand = vi.fn();
    piLazy({ registerCommand } as unknown as ExtensionAPI);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith(
      "lazy",
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
  });

  it("restores the complete command when Pi is busy", async () => {
    let registered:
      | { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
      | undefined;
    piLazy({
      registerCommand: (_name: string, command: typeof registered) => {
        registered = command;
      },
    } as unknown as ExtensionAPI);

    let editorText = "";
    const notify = vi.fn();
    const ctx = {
      mode: "tui",
      isIdle: () => false,
      ui: {
        getEditorText: () => editorText,
        setEditorText: (text: string) => {
          editorText = text;
        },
        notify,
      },
    } as unknown as ExtensionCommandContext;

    await registered?.handler("rough words", ctx);
    expect(editorText).toBe("/lazy rough words");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("restored"), "warning");
  });
});

describe("replaceEditorIfUnchanged", () => {
  it("replaces the expected editor state", () => {
    let text = "";
    const ui = {
      getEditorText: () => text,
      setEditorText: vi.fn((replacement: string) => {
        text = replacement;
      }),
    };

    expect(replaceEditorIfUnchanged(ui, "", "corrected")).toBe(true);
    expect(text).toBe("corrected");
    expect(ui.setEditorText).toHaveBeenCalledWith("corrected");
  });

  it("preserves a concurrently changed editor", () => {
    const ui = {
      getEditorText: () => "new draft",
      setEditorText: vi.fn(),
    };

    expect(replaceEditorIfUnchanged(ui, "", "corrected")).toBe(false);
    expect(ui.setEditorText).not.toHaveBeenCalled();
  });
});
