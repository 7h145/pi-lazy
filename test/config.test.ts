import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  it("applies defaults", () => {
    expect(parseSettings({})).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });

  it("accepts all supported settings", () => {
    expect(
      parseSettings({
        model: "openrouter/anthropic/claude",
        thinkingLevel: "minimal",
        maxContextChars: 12_000,
        fallbackToCurrentModel: true,
      }),
    ).toEqual({
      ok: true,
      settings: {
        model: "openrouter/anthropic/claude",
        thinkingLevel: "minimal",
        maxContextChars: 12_000,
        fallbackToCurrentModel: true,
      },
    });
  });

  it.each([null, [], "settings"])("rejects non-object value %j", (value) => {
    expect(parseSettings(value)).toMatchObject({ ok: false });
  });

  it("rejects unknown keys", () => {
    expect(parseSettings({ maxContextChar: 10 })).toEqual({
      ok: false,
      error: 'unknown setting "maxContextChar"',
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

  it("rejects non-boolean fallback", () => {
    expect(parseSettings({ fallbackToCurrentModel: "yes" })).toMatchObject({ ok: false });
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
    await writeFile(path, '{"maxContextChars":100}');
    await expect(loadSettings(path)).resolves.toMatchObject({
      ok: true,
      settings: { maxContextChars: 100 },
    });
    await writeFile(path, '{"maxContextChars":200}');
    await expect(loadSettings(path)).resolves.toMatchObject({
      ok: true,
      settings: { maxContextChars: 200 },
    });
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-lazy-"));
  temporaryDirectories.push(path);
  return path;
}
