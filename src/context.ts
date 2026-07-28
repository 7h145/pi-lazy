import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTEXT_SEPARATOR = "\n\n";
const EARLIER_CONTEXT_OMITTED = "[Earlier context omitted.]";

interface ContextItem {
  label: string;
  text: string;
}

export function buildConversationContext(
  entries: readonly SessionEntry[],
  maxCharacters: number,
): string {
  if (maxCharacters <= 0) return "";

  const rendered = extractContextItems(entries).map(renderContextItem);
  if (rendered.length === 0) return "";

  const selected: string[] = [];
  let selectedLength = 0;
  let omitted = false;

  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index];
    if (item === undefined) continue;
    const separatorLength = selected.length > 0 ? charLength(CONTEXT_SEPARATOR) : 0;
    const candidateLength = charLength(item) + separatorLength + selectedLength;

    if (candidateLength <= maxCharacters) {
      selected.unshift(item);
      selectedLength = candidateLength;
      continue;
    }

    omitted = true;
    if (selected.length === 0) {
      return truncateNewestItem(item, maxCharacters);
    }
    break;
  }

  let result = selected.join(CONTEXT_SEPARATOR);
  if (omitted) {
    const marked = `${EARLIER_CONTEXT_OMITTED}${CONTEXT_SEPARATOR}${result}`;
    if (charLength(marked) <= maxCharacters) result = marked;
  }
  return result;
}

export function extractContextItems(entries: readonly SessionEntry[]): ContextItem[] {
  const items: ContextItem[] = [];

  for (const entry of entries) {
    if (entry.type === "compaction") {
      addItem(items, "Conversation summary", entry.summary);
      continue;
    }
    if (entry.type === "branch_summary") {
      addItem(items, "Branch summary", entry.summary);
      continue;
    }
    if (entry.type !== "message") continue;

    if (entry.message.role === "user") {
      addItem(items, "User", extractText(entry.message.content));
    } else if (entry.message.role === "assistant") {
      addItem(items, "Assistant", extractText(entry.message.content));
    }
  }

  return items;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        Reflect.get(part, "type") === "text" &&
        typeof Reflect.get(part, "text") === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function addItem(items: ContextItem[], label: string, text: string): void {
  const normalized = text.trim();
  if (normalized) items.push({ label, text: normalized });
}

function renderContextItem(item: ContextItem): string {
  return `${item.label}: ${item.text}`;
}

function truncateNewestItem(item: string, maxCharacters: number): string {
  const marker = "[Earlier text in this message omitted.] ";
  if (charLength(marker) >= maxCharacters) return takeTail(item, maxCharacters);
  return `${marker}${takeTail(item, maxCharacters - charLength(marker))}`;
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function takeTail(text: string, characters: number): string {
  if (characters <= 0) return "";
  const values = Array.from(text);
  return values.length <= characters ? text : values.slice(-characters).join("");
}
