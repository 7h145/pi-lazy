import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { LazySettings, LazyThinkingLevel } from "./config.js";
import { parseModelReference } from "./config.js";
import { buildCorrectionPrompt, CORRECTION_SYSTEM_PROMPT } from "./prompt.js";

export interface RequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<RequestAuth & { ok: true } | { ok: false; error: string }>;
}

export type ModelResolution =
  | { ok: true; model: Model<Api>; auth: RequestAuth; warning?: string }
  | { ok: false; error: string };

export interface CorrectionRequest {
  draft: string;
  conversationContext: string;
  model: Model<Api>;
  auth: RequestAuth;
  thinkingLevel: LazyThinkingLevel;
  signal?: AbortSignal;
}

export type CorrectionResult =
  | { kind: "corrected"; text: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export type CompletionFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export async function resolveCorrectionModel(
  settings: LazySettings,
  currentModel: Model<Api> | undefined,
  registry: ModelRegistryLike,
): Promise<ModelResolution> {
  if (!settings.model) {
    return authenticateCurrentModel(currentModel, registry);
  }

  const reference = parseModelReference(settings.model);
  if (!reference) {
    return { ok: false, error: `Configured correction model ${JSON.stringify(settings.model)} is invalid` };
  }

  const configured = registry.find(reference.provider, reference.modelId);
  if (!configured) {
    return fallbackOrFail(
      `Configured correction model ${settings.model} was not found`,
      settings,
      currentModel,
      registry,
    );
  }

  const configuredAuth = await authenticate(configured, registry);
  if (configuredAuth.ok) {
    return { ok: true, model: configured, auth: configuredAuth.auth };
  }

  return fallbackOrFail(
    `Configured correction model ${settings.model} is unavailable: ${configuredAuth.error}`,
    settings,
    currentModel,
    registry,
    configured,
  );
}

export async function runCorrection(
  request: CorrectionRequest,
  completion: CompletionFunction = completeSimple,
): Promise<CorrectionResult> {
  if (request.signal?.aborted) return { kind: "cancelled" };

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildCorrectionPrompt(request.conversationContext, request.draft),
      },
    ],
    timestamp: Date.now(),
  };

  const options: SimpleStreamOptions = {
    apiKey: request.auth.apiKey,
    headers: request.auth.headers,
    env: request.auth.env,
    signal: request.signal,
  };
  if (request.thinkingLevel !== "off") options.reasoning = request.thinkingLevel;

  let response: AssistantMessage;
  try {
    response = await completion(
      request.model,
      { systemPrompt: CORRECTION_SYSTEM_PROMPT, messages: [userMessage] },
      options,
    );
  } catch (error: unknown) {
    if (request.signal?.aborted) return { kind: "cancelled" };
    return { kind: "error", message: formatError(error) };
  }

  if (request.signal?.aborted || response.stopReason === "aborted") {
    return { kind: "cancelled" };
  }
  if (response.stopReason === "error") {
    return { kind: "error", message: response.errorMessage ?? "The correction model returned an error" };
  }
  if (response.stopReason !== "stop") {
    return {
      kind: "error",
      message: `The correction model stopped before completing the draft (${response.stopReason})`,
    };
  }

  const text = extractAssistantText(response);
  return text
    ? { kind: "corrected", text }
    : { kind: "error", message: "The correction model returned no text" };
}

export function extractAssistantText(response: Pick<AssistantMessage, "content">): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function fallbackOrFail(
  reason: string,
  settings: LazySettings,
  currentModel: Model<Api> | undefined,
  registry: ModelRegistryLike,
  configuredModel?: Model<Api>,
): Promise<ModelResolution> {
  if (!settings.fallbackToCurrentModel) return { ok: false, error: reason };
  if (configuredModel && sameModel(configuredModel, currentModel)) {
    return { ok: false, error: `${reason}; the current model is the same model` };
  }

  const fallback = await authenticateCurrentModel(currentModel, registry);
  if (!fallback.ok) {
    return { ok: false, error: `${reason}; fallback failed: ${fallback.error}` };
  }
  return {
    ...fallback,
    warning: `${reason}; using current model ${fallback.model.provider}/${fallback.model.id}`,
  };
}

async function authenticateCurrentModel(
  currentModel: Model<Api> | undefined,
  registry: ModelRegistryLike,
): Promise<ModelResolution> {
  if (!currentModel) return { ok: false, error: "No current model is selected" };
  const auth = await authenticate(currentModel, registry);
  return auth.ok
    ? { ok: true, model: currentModel, auth: auth.auth }
    : {
        ok: false,
        error: `Current model ${currentModel.provider}/${currentModel.id} is unavailable: ${auth.error}`,
      };
}

async function authenticate(
  model: Model<Api>,
  registry: ModelRegistryLike,
): Promise<{ ok: true; auth: RequestAuth } | { ok: false; error: string }> {
  try {
    const result = await registry.getApiKeyAndHeaders(model);
    if (!result.ok) return result;
    return {
      ok: true,
      auth: { apiKey: result.apiKey, headers: result.headers, env: result.env },
    };
  } catch (error: unknown) {
    return { ok: false, error: formatError(error) };
  }
}

function sameModel(first: Model<Api>, second: Model<Api> | undefined): boolean {
  return first.provider === second?.provider && first.id === second.id;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
