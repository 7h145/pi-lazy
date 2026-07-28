import { readFile } from "node:fs/promises";

export const CURRENT_MODEL_REFERENCE = "$current";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type LazyThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface LazySettings {
  modelChain: string[];
  thinkingLevel: LazyThinkingLevel;
  maxContextChars: number;
}

export const DEFAULT_SETTINGS: Readonly<LazySettings> = {
  modelChain: [CURRENT_MODEL_REFERENCE],
  thinkingLevel: "off",
  maxContextChars: 8_000,
};

export const MAX_CONTEXT_CHARS = 100_000;

export type SettingsLoadResult =
  | { ok: true; settings: LazySettings }
  | { ok: false; error: string };

const SETTINGS_KEYS = new Set(["modelChain", "thinkingLevel", "maxContextChars"]);

export function parseModelReference(
  reference: string,
): { provider: string; modelId: string } | undefined {
  if (!reference || /\s/.test(reference)) return undefined;
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return {
    provider: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
  };
}

export function parseSettings(value: unknown): SettingsLoadResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "settings must be a JSON object" };
  }

  const unknownKeys = Object.keys(value).filter((key) => !SETTINGS_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `unknown setting ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`,
    };
  }

  const settings: LazySettings = {
    ...DEFAULT_SETTINGS,
    modelChain: [...DEFAULT_SETTINGS.modelChain],
  };

  if (Object.hasOwn(value, "modelChain")) {
    if (!Array.isArray(value.modelChain) || value.modelChain.length === 0) {
      return { ok: false, error: '"modelChain" must be a nonempty array' };
    }

    const modelChain: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value.modelChain) {
      if (
        typeof candidate !== "string" ||
        (candidate !== CURRENT_MODEL_REFERENCE && !parseModelReference(candidate))
      ) {
        return {
          ok: false,
          error: `each "modelChain" entry must be ${JSON.stringify(CURRENT_MODEL_REFERENCE)} or use non-whitespace "provider/model-id" form`,
        };
      }
      if (seen.has(candidate)) {
        return {
          ok: false,
          error: `"modelChain" contains duplicate entry ${JSON.stringify(candidate)}`,
        };
      }
      seen.add(candidate);
      modelChain.push(candidate);
    }
    settings.modelChain = modelChain;
  }

  if (Object.hasOwn(value, "thinkingLevel")) {
    if (!isThinkingLevel(value.thinkingLevel)) {
      return {
        ok: false,
        error: `"thinkingLevel" must be one of ${THINKING_LEVELS.map((level) => JSON.stringify(level)).join(", ")}`,
      };
    }
    settings.thinkingLevel = value.thinkingLevel;
  }

  if (Object.hasOwn(value, "maxContextChars")) {
    if (
      typeof value.maxContextChars !== "number" ||
      !Number.isInteger(value.maxContextChars) ||
      value.maxContextChars < 0 ||
      value.maxContextChars > MAX_CONTEXT_CHARS
    ) {
      return {
        ok: false,
        error: `"maxContextChars" must be an integer from 0 through ${MAX_CONTEXT_CHARS}`,
      };
    }
    settings.maxContextChars = value.maxContextChars;
  }

  return { ok: true, settings };
}

export async function loadSettings(path: string): Promise<SettingsLoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: true,
        settings: { ...DEFAULT_SETTINGS, modelChain: [...DEFAULT_SETTINGS.modelChain] },
      };
    }
    return { ok: false, error: `${path}: ${formatError(error)}` };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return { ok: false, error: `${path}: invalid JSON (${formatError(error)})` };
  }

  const result = parseSettings(value);
  return result.ok ? result : { ok: false, error: `${path}: ${result.error}` };
}

function isThinkingLevel(value: unknown): value is LazyThinkingLevel {
  return THINKING_LEVELS.includes(value as LazyThinkingLevel);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
