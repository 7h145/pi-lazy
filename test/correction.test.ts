import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { LazySettings } from "../src/config.js";
import {
  extractAssistantText,
  resolveCorrectionModel,
  runCorrection,
  type CompletionFunction,
  type ModelRegistryLike,
} from "../src/correction.js";

const currentModel = model("main", "large");
const smallModel = model("small", "fast");

function model(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_000,
  };
}

function settings(overrides: Partial<LazySettings> = {}): LazySettings {
  return {
    thinkingLevel: "off",
    maxContextChars: 8_000,
    fallbackToCurrentModel: false,
    ...overrides,
  };
}

function registry(options: {
  models?: Model<Api>[];
  unavailable?: Model<Api>[];
  throws?: Model<Api>[];
} = {}): ModelRegistryLike {
  const models = options.models ?? [currentModel, smallModel];
  return {
    find: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    getApiKeyAndHeaders: async (candidate) => {
      if (options.throws?.includes(candidate)) throw new Error("credential command failed");
      if (options.unavailable?.includes(candidate)) return { ok: false, error: "not logged in" };
      return { ok: true, apiKey: `key-${candidate.id}`, headers: { "x-test": "yes" } };
    },
  };
}

function response(
  stopReason: AssistantMessage["stopReason"] = "stop",
  content: AssistantMessage["content"] = [{ type: "text", text: "corrected" }],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "small",
    model: "fast",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("resolveCorrectionModel", () => {
  it("uses the current model when none is configured", async () => {
    await expect(resolveCorrectionModel(settings(), currentModel, registry())).resolves.toMatchObject({
      ok: true,
      model: currentModel,
      auth: { apiKey: "key-large" },
    });
  });

  it("uses an independent configured model", async () => {
    await expect(
      resolveCorrectionModel(settings({ model: "small/fast" }), currentModel, registry()),
    ).resolves.toMatchObject({ ok: true, model: smallModel, auth: { apiKey: "key-fast" } });
  });

  it("fails closed when a configured model is missing", async () => {
    await expect(
      resolveCorrectionModel(settings({ model: "missing/model" }), currentModel, registry()),
    ).resolves.toEqual({
      ok: false,
      error: "Configured correction model missing/model was not found",
    });
  });

  it("warns and falls back only when enabled", async () => {
    const result = await resolveCorrectionModel(
      settings({ model: "missing/model", fallbackToCurrentModel: true }),
      currentModel,
      registry(),
    );
    expect(result).toMatchObject({ ok: true, model: currentModel });
    if (result.ok) expect(result.warning).toContain("using current model main/large");
  });

  it("reports configured and fallback failures together", async () => {
    const result = await resolveCorrectionModel(
      settings({ model: "small/fast", fallbackToCurrentModel: true }),
      currentModel,
      registry({ unavailable: [smallModel, currentModel] }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("small/fast is unavailable");
      expect(result.error).toContain("fallback failed");
    }
  });

  it("does not retry the same unavailable model as its own fallback", async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false as const, error: "unavailable" }));
    const customRegistry: ModelRegistryLike = {
      find: () => currentModel,
      getApiKeyAndHeaders,
    };
    const result = await resolveCorrectionModel(
      settings({ model: "main/large", fallbackToCurrentModel: true }),
      currentModel,
      customRegistry,
    );
    expect(result).toMatchObject({ ok: false });
    expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
  });

  it("turns credential resolver exceptions into errors", async () => {
    const result = await resolveCorrectionModel(
      settings({ model: "small/fast" }),
      currentModel,
      registry({ throws: [smallModel] }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("credential command failed");
  });
});

describe("runCorrection", () => {
  it("sends context before draft and omits reasoning when off", async () => {
    let capturedContext: Context | undefined;
    let capturedOptions: SimpleStreamOptions | undefined;
    const completion: CompletionFunction = async (_model, context, options) => {
      capturedContext = context;
      capturedOptions = options;
      return response();
    };

    await expect(
      runCorrection(
        {
          draft: "rough marker",
          conversationContext: "context marker",
          model: smallModel,
          auth: { apiKey: "key", env: { TEST: "yes" } },
          thinkingLevel: "off",
        },
        completion,
      ),
    ).resolves.toEqual({ kind: "corrected", text: "corrected" });

    const prompt = capturedContext?.messages[0];
    const firstPart = prompt && Array.isArray(prompt.content) ? prompt.content[0] : undefined;
    const text = firstPart?.type === "text" ? firstPart.text : undefined;
    expect(text?.indexOf("context marker")).toBeLessThan(text?.indexOf("rough marker") ?? -1);
    expect(capturedContext?.systemPrompt).toContain("Do not answer the draft");
    expect(capturedOptions).toMatchObject({ apiKey: "key", env: { TEST: "yes" } });
    expect(capturedOptions).not.toHaveProperty("reasoning");
  });

  it("passes a configured thinking level", async () => {
    let capturedOptions: SimpleStreamOptions | undefined;
    await runCorrection(
      {
        draft: "rough",
        conversationContext: "",
        model: smallModel,
        auth: {},
        thinkingLevel: "minimal",
      },
      async (_model, _context, options) => {
        capturedOptions = options;
        return response();
      },
    );
    expect(capturedOptions?.reasoning).toBe("minimal");
  });

  it("joins text blocks and excludes thinking", async () => {
    const result = await runCorrection(
      {
        draft: "rough",
        conversationContext: "",
        model: smallModel,
        auth: {},
        thinkingLevel: "off",
      },
      async () =>
        response("stop", [
          { type: "text", text: " first " },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "second " },
        ]),
    );
    expect(result).toEqual({ kind: "corrected", text: "first \nsecond" });
  });

  it.each(["length", "toolUse"] as const)("rejects incomplete stop reason %s", async (stopReason) => {
    const result = await runCorrection(
      {
        draft: "rough",
        conversationContext: "",
        model: smallModel,
        auth: {},
        thinkingLevel: "off",
      },
      async () => response(stopReason),
    );
    expect(result).toMatchObject({ kind: "error" });
  });

  it("maps response and thrown aborts to cancellation", async () => {
    const controller = new AbortController();
    const request = {
      draft: "rough",
      conversationContext: "",
      model: smallModel,
      auth: {},
      thinkingLevel: "off" as const,
      signal: controller.signal,
    };
    expect(await runCorrection(request, async () => response("aborted"))).toEqual({ kind: "cancelled" });

    const completion: CompletionFunction = async () => {
      controller.abort();
      throw new Error("aborted request");
    };
    expect(await runCorrection(request, completion)).toEqual({ kind: "cancelled" });
  });

  it("reports provider errors, exceptions, and empty output", async () => {
    const request = {
      draft: "rough",
      conversationContext: "",
      model: smallModel,
      auth: {},
      thinkingLevel: "off" as const,
    };
    const providerError = response("error");
    providerError.errorMessage = "rate limited";
    expect(await runCorrection(request, async () => providerError)).toEqual({
      kind: "error",
      message: "rate limited",
    });
    expect(
      await runCorrection(request, async () => {
        throw new Error("network down");
      }),
    ).toEqual({ kind: "error", message: "network down" });
    expect(await runCorrection(request, async () => response("stop", []))).toEqual({
      kind: "error",
      message: "The correction model returned no text",
    });
  });
});

describe("extractAssistantText", () => {
  it("returns trimmed text only", () => {
    expect(
      extractAssistantText(response("stop", [{ type: "text", text: "  corrected  " }])),
    ).toBe("corrected");
  });
});
