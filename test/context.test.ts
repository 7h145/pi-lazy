import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildConversationContext, extractContextItems } from "../src/context.js";

let nextId = 0;

function entry(value: object): SessionEntry {
  nextId += 1;
  return {
    id: String(nextId),
    parentId: nextId === 1 ? null : String(nextId - 1),
    timestamp: new Date(0).toISOString(),
    ...value,
  } as SessionEntry;
}

describe("extractContextItems", () => {
  it("extracts user and assistant text in chronological order", () => {
    const entries = [
      entry({ type: "message", message: { role: "user", content: "  hello  " } }),
      entry({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "first" },
            { type: "toolCall", name: "read", arguments: {} },
            { type: "text", text: "second" },
          ],
        },
      }),
    ];

    expect(extractContextItems(entries)).toEqual([
      { label: "User", text: "hello" },
      { label: "Assistant", text: "first\nsecond" },
    ]);
  });

  it("includes compaction and branch summaries", () => {
    expect(
      extractContextItems([
        entry({ type: "compaction", summary: "Earlier work", firstKeptEntryId: "x", tokensBefore: 4 }),
        entry({ type: "branch_summary", summary: "Other branch", fromId: "x" }),
      ]),
    ).toEqual([
      { label: "Conversation summary", text: "Earlier work" },
      { label: "Branch summary", text: "Other branch" },
    ]);
  });

  it("excludes tools, custom messages, empty text, and images", () => {
    const entries = [
      entry({
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "noisy output" }],
        },
      }),
      entry({ type: "custom_message", customType: "rules", content: "hidden", display: false }),
      entry({ type: "message", message: { role: "user", content: [{ type: "image", data: "abc" }] } }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] } }),
    ];

    expect(extractContextItems(entries)).toEqual([]);
  });
});

describe("buildConversationContext", () => {
  it("renders labels and multiline text", () => {
    const context = buildConversationContext(
      [
        entry({ type: "message", message: { role: "user", content: "hello" } }),
        entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi\nthere" }] } }),
      ],
      1_000,
    );

    expect(context).toBe("User: hello\n\nAssistant: hi\nthere");
  });

  it("returns no context for a zero budget", () => {
    expect(
      buildConversationContext(
        [entry({ type: "message", message: { role: "user", content: "hello" } })],
        0,
      ),
    ).toBe("");
  });

  it("keeps the newest complete messages that fit", () => {
    const context = buildConversationContext(
      [
        entry({ type: "message", message: { role: "user", content: "a".repeat(100) } }),
        entry({ type: "message", message: { role: "assistant", content: "recent" } }),
      ],
      60,
    );

    expect(context).toContain("[Earlier context omitted.]");
    expect(context).toContain("Assistant: recent");
    expect(Array.from(context).length).toBeLessThanOrEqual(60);
  });

  it("truncates the tail of one oversized newest message", () => {
    const context = buildConversationContext(
      [entry({ type: "message", message: { role: "user", content: `start-${"x".repeat(100)}-end` } })],
      50,
    );

    expect(Array.from(context).length).toBe(50);
    expect(context).toContain("[Earlier text in this message omitted.] ");
    expect(context.endsWith("-end")).toBe(true);
    expect(context).not.toContain("start-");
  });

  it("does not split Unicode code points at the budget boundary", () => {
    const context = buildConversationContext(
      [entry({ type: "message", message: { role: "user", content: "🙂".repeat(20) } })],
      10,
    );

    expect(context).not.toContain("�");
    expect(Array.from(context)).toHaveLength(10);
  });
});
