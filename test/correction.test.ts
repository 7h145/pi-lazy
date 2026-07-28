import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  modelChainFingerprint,
  resolveModelCandidate,
  runCorrection,
  runCorrectionChain,
  type CompletionFunction,
  type ModelRegistryLike,
} from "../src/correction.js";

const currentModel = model("main", "large");
const smallModel = model("small", "fast");
const lunaModel = model("openai", "luna");

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

function registry(options: {
  models?: Model<Api>[];
  unavailable?: Model<Api>[];
  throws?: Model<Api>[];
} = {}): ModelRegistryLike {
  const models = options.models ?? [currentModel, smallModel, lunaModel];
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

function chainRequest(overrides: Partial<Parameters<typeof runCorrectionChain>[0]> = {}) {
  return {
    modelChain: ["small/fast", "openai/luna", "$current"],
    startIndex: 0,
    currentModel,
    registry: registry(),
    draft: "rough",
    conversationContext: "context",
    thinkingLevel: "off" as const,
    ...overrides,
  };
}

describe("resolveModelCandidate", () => {
  it("resolves explicit and current models", async () => {
    await expect(resolveModelCandidate("small/fast", currentModel, registry())).resolves.toMatchObject({
      ok: true,
      model: smallModel,
      auth: { apiKey: "key-fast" },
    });
    await expect(resolveModelCandidate("$current", currentModel, registry())).resolves.toMatchObject({
      ok: true,
      model: currentModel,
      auth: { apiKey: "key-large" },
    });
  });

  it("reports unknown, unauthenticated, and missing current models", async () => {
    await expect(resolveModelCandidate("missing/model", currentModel, registry())).resolves.toEqual({
      ok: false,
      error: "model was not found",
    });
    await expect(
      resolveModelCandidate("small/fast", currentModel, registry({ unavailable: [smallModel] })),
    ).resolves.toEqual({ ok: false, error: "not logged in" });
    await expect(resolveModelCandidate("$current", undefined, registry())).resolves.toEqual({
      ok: false,
      error: "no current session model is selected",
    });
  });

  it("turns credential resolver exceptions into errors", async () => {
    await expect(
      resolveModelCandidate("small/fast", currentModel, registry({ throws: [smallModel] })),
    ).resolves.toEqual({ ok: false, error: "credential command failed" });
  });
});

describe("runCorrectionChain", () => {
  it("falls back after a runtime connection failure", async () => {
    const completion = vi.fn<CompletionFunction>(async (selected) => {
      if (selected === smallModel) throw new Error("Connection error.");
      return response();
    });
    const onFailure = vi.fn();

    const result = await runCorrectionChain(chainRequest({ onFailure }), completion);

    expect(result).toMatchObject({
      kind: "corrected",
      candidateIndex: 1,
      modelLabel: "openai/luna",
      failures: [{ modelLabel: "small/fast", message: "Connection error." }],
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ modelLabel: "small/fast", message: "Connection error." }),
      "openai/luna",
    );
  });

  it("falls back after resolution and authentication failures", async () => {
    const result = await runCorrectionChain(
      chainRequest({
        modelChain: ["missing/model", "small/fast", "$current"],
        registry: registry({ unavailable: [smallModel] }),
      }),
      async () => response(),
    );

    expect(result).toMatchObject({
      kind: "corrected",
      candidateIndex: 2,
      modelLabel: "main/large",
      failures: [
        { modelLabel: "missing/model", message: "model was not found" },
        { modelLabel: "small/fast", message: "not logged in" },
      ],
    });
  });

  it("falls back after incomplete and empty responses", async () => {
    const completion = vi.fn<CompletionFunction>(async (selected) => {
      if (selected === smallModel) return response("length");
      if (selected === lunaModel) return response("stop", []);
      return response();
    });
    const result = await runCorrectionChain(chainRequest(), completion);
    expect(result).toMatchObject({ kind: "corrected", candidateIndex: 2 });
    expect(completion).toHaveBeenCalledTimes(3);
  });

  it("does not fall back after cancellation", async () => {
    const completion = vi.fn<CompletionFunction>(async () => response("aborted"));
    const result = await runCorrectionChain(chainRequest(), completion);
    expect(result).toEqual({ kind: "cancelled" });
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it("starts at the remembered candidate index", async () => {
    const completion = vi.fn<CompletionFunction>(async () => response());
    const result = await runCorrectionChain(chainRequest({ startIndex: 1 }), completion);
    expect(result).toMatchObject({ kind: "corrected", candidateIndex: 1 });
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0]?.[0]).toBe(lunaModel);
  });

  it("does not retry an explicit model through $current", async () => {
    const completion = vi.fn<CompletionFunction>(async (selected) => {
      if (selected === currentModel) throw new Error("offline");
      return response();
    });
    const result = await runCorrectionChain(
      chainRequest({ modelChain: ["main/large", "$current", "openai/luna"] }),
      completion,
    );
    expect(result).toMatchObject({
      kind: "corrected",
      candidateIndex: 2,
      failures: [
        { modelLabel: "main/large", message: "offline" },
        { message: "duplicates an earlier model in the chain" },
      ],
    });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("combines failures when the chain is exhausted", async () => {
    const result = await runCorrectionChain(
      chainRequest({ modelChain: ["small/fast", "openai/luna"] }),
      async () => {
        throw new Error("offline");
      },
    );
    expect(result).toMatchObject({ kind: "exhausted" });
    if (result.kind === "exhausted") {
      expect(result.message).toContain("small/fast: offline");
      expect(result.message).toContain("openai/luna: offline");
    }
  });

  it("returns a fast exhausted result when no candidate remains", async () => {
    await expect(
      runCorrectionChain(chainRequest({ startIndex: 3 }), async () => response()),
    ).resolves.toEqual({
      kind: "exhausted",
      message: "No usable correction model remains. Run /reload to retry the model chain.",
      failures: [],
    });
  });
});

describe("modelChainFingerprint", () => {
  it("changes with chain configuration and the current model when referenced", () => {
    const first = modelChainFingerprint(["small/fast", "$current"], currentModel);
    expect(modelChainFingerprint(["small/fast", "$current"], lunaModel)).not.toBe(first);
    expect(modelChainFingerprint(["small/fast"], currentModel)).toBe(
      modelChainFingerprint(["small/fast"], lunaModel),
    );
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
