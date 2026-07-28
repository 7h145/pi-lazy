import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_MODEL_REFERENCE,
  DEFAULT_SETTINGS,
  MAX_CONTEXT_CHARS,
  loadSettings,
  parseModelReference,
  parseSettings,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("parseModelReference", () => {
  it("splits only the first slash", () => {
    expect(parseModelReference("openrouter/anthropic/claude-sonnet")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
    });
  });

  it.each(["", "provider", "/model", "provider/", "provider/model id"])(
    "rejects invalid reference %j",
    (reference) => expect(parseModelReference(reference)).toBeUndefined(),
  );
});

describe("parseSettings", () => {
  it("defaults to the current session model", () => {
    expect(parseSettings({})).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS.modelChain).toEqual([CURRENT_MODEL_REFERENCE]);
  });

  it("accepts an ordered model chain", () => {
    expect(
      parseSettings({
        modelChain: ["local/chat-flash", "openai/gpt-luna", CURRENT_MODEL_REFERENCE],
        thinkingLevel: "minimal",
        maxContextChars: 12_000,
      }),
    ).toEqual({
      ok: true,
      settings: {
        modelChain: ["local/chat-flash", "openai/gpt-luna", CURRENT_MODEL_REFERENCE],
        thinkingLevel: "minimal",
        maxContextChars: 12_000,
      },
    });
  });

  it.each([null, [], "settings"])("rejects non-object value %j", (value) => {
    expect(parseSettings(value)).toMatchObject({ ok: false });
  });

  it("rejects unknown and removed settings", () => {
    expect(parseSettings({ model: "local/model" })).toEqual({
      ok: false,
      error: 'unknown setting "model"',
    });
    expect(parseSettings({ fallbackToCurrentModel: true })).toMatchObject({ ok: false });
  });

  it.each([[], "local/model", null])("rejects invalid model chain %j", (modelChain) => {
    expect(parseSettings({ modelChain })).toMatchObject({ ok: false });
  });

  it.each([
    { modelChain: ["invalid"] },
    { modelChain: ["local/model", 2] },
    { modelChain: ["$unknown"] },
  ])("rejects invalid model-chain entries $modelChain", ({ modelChain }) => {
    expect(parseSettings({ modelChain })).toMatchObject({ ok: false });
  });

  it("rejects exact duplicate model-chain entries", () => {
    expect(parseSettings({ modelChain: ["local/model", "local/model"] })).toEqual({
      ok: false,
      error: '"modelChain" contains duplicate entry "local/model"',
    });
  });

  it.each(["extreme", 1, null])("rejects thinking level %j", (thinkingLevel) => {
    expect(parseSettings({ thinkingLevel })).toMatchObject({ ok: false });
  });

  it.each([-1, 1.5, MAX_CONTEXT_CHARS + 1, "8000"])(
    "rejects context limit %j",
    (maxContextChars) => {
      expect(parseSettings({ maxContextChars })).toMatchObject({ ok: false });
    },
  );

  it.each([0, MAX_CONTEXT_CHARS])("accepts boundary context limit %d", (maxContextChars) => {
    expect(parseSettings({ maxContextChars })).toMatchObject({
      ok: true,
      settings: { maxContextChars },
    });
  });
});

describe("loadSettings", () => {
  it("uses defaults for a missing file", async () => {
    const directory = await makeTemporaryDirectory();
    await expect(loadSettings(join(directory, "missing.json"))).resolves.toEqual({
      ok: true,
      settings: DEFAULT_SETTINGS,
    });
  });

  it("reports invalid JSON with the path", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "pi-lazy.json");
    await writeFile(path, "{");
    const result = await loadSettings(path);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(path);
  });

  it("reads the file anew on every invocation", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "pi-lazy.json");
    await writeFile(path, '{"modelChain":["first/model"]}');
    await expect(loadSettings(path)).resolves.toMatchObject({
      ok: true,
      settings: { modelChain: ["first/model"] },
    });
    await writeFile(path, '{"modelChain":["second/model","$current"]}');
    await expect(loadSettings(path)).resolves.toMatchObject({
      ok: true,
      settings: { modelChain: ["second/model", "$current"] },
    });
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-lazy-"));
  temporaryDirectories.push(path);
  return path;
}
