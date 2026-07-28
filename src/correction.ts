import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  CURRENT_MODEL_REFERENCE,
  parseModelReference,
  type LazyThinkingLevel,
} from "./config.js";
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

export interface ModelAttemptFailure {
  candidateIndex: number;
  modelLabel: string;
  message: string;
}

export type CorrectionChainResult =
  | {
      kind: "corrected";
      text: string;
      candidateIndex: number;
      modelLabel: string;
      failures: ModelAttemptFailure[];
    }
  | { kind: "cancelled" }
  | { kind: "exhausted"; message: string; failures: ModelAttemptFailure[] };

export interface CorrectionChainRequest {
  modelChain: readonly string[];
  startIndex: number;
  currentModel: Model<Api> | undefined;
  registry: ModelRegistryLike;
  draft: string;
  conversationContext: string;
  thinkingLevel: LazyThinkingLevel;
  signal?: AbortSignal;
  onFailure?: (failure: ModelAttemptFailure, nextModelLabel: string | undefined) => void;
}

export type CompletionFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export async function runCorrectionChain(
  request: CorrectionChainRequest,
  completion: CompletionFunction = completeSimple,
): Promise<CorrectionChainResult> {
  if (request.signal?.aborted) return { kind: "cancelled" };

  const failures: ModelAttemptFailure[] = [];
  const seenModelKeys = new Set<string>();
  for (let index = 0; index < request.startIndex; index += 1) {
    const reference = request.modelChain[index];
    const key = reference && modelReferenceKey(reference, request.currentModel);
    if (key) seenModelKeys.add(key);
  }

  for (let index = request.startIndex; index < request.modelChain.length; index += 1) {
    if (request.signal?.aborted) return { kind: "cancelled" };
    const reference = request.modelChain[index];
    if (reference === undefined) continue;
    const modelLabel = describeModelReference(reference, request.currentModel);
    const modelKey = modelReferenceKey(reference, request.currentModel);

    if (modelKey && seenModelKeys.has(modelKey)) {
      const failure = {
        candidateIndex: index,
        modelLabel,
        message: "duplicates an earlier model in the chain",
      };
      failures.push(failure);
      request.onFailure?.(
        failure,
        describeNextReference(request.modelChain, index + 1, request.currentModel),
      );
      continue;
    }
    if (modelKey) seenModelKeys.add(modelKey);

    const resolution = await resolveModelCandidate(reference, request.currentModel, request.registry);
    if (!resolution.ok) {
      const failure = { candidateIndex: index, modelLabel, message: resolution.error };
      failures.push(failure);
      request.onFailure?.(
        failure,
        describeNextReference(request.modelChain, index + 1, request.currentModel),
      );
      continue;
    }

    const correction = await runCorrection(
      {
        draft: request.draft,
        conversationContext: request.conversationContext,
        model: resolution.model,
        auth: resolution.auth,
        thinkingLevel: request.thinkingLevel,
        signal: request.signal,
      },
      completion,
    );

    if (correction.kind === "cancelled") return correction;
    if (correction.kind === "corrected") {
      return {
        ...correction,
        candidateIndex: index,
        modelLabel: `${resolution.model.provider}/${resolution.model.id}`,
        failures,
      };
    }

    const failure = {
      candidateIndex: index,
      modelLabel: `${resolution.model.provider}/${resolution.model.id}`,
      message: correction.message,
    };
    failures.push(failure);
    request.onFailure?.(
      failure,
      describeNextReference(request.modelChain, index + 1, request.currentModel),
    );
  }

  return {
    kind: "exhausted",
    message:
      failures.length > 0
        ? `No correction model succeeded: ${failures.map(formatFailure).join("; ")}`
        : "No usable correction model remains. Run /reload to retry the model chain.",
    failures,
  };
}

export async function resolveModelCandidate(
  reference: string,
  currentModel: Model<Api> | undefined,
  registry: ModelRegistryLike,
): Promise<
  | { ok: true; model: Model<Api>; auth: RequestAuth }
  | { ok: false; error: string }
> {
  let model: Model<Api> | undefined;
  if (reference === CURRENT_MODEL_REFERENCE) {
    model = currentModel;
    if (!model) return { ok: false, error: "no current session model is selected" };
  } else {
    const parsed = parseModelReference(reference);
    if (!parsed) return { ok: false, error: `invalid model reference ${JSON.stringify(reference)}` };
    model = registry.find(parsed.provider, parsed.modelId);
    if (!model) return { ok: false, error: "model was not found" };
  }

  const auth = await authenticate(model, registry);
  return auth.ok ? { ok: true, model, auth: auth.auth } : auth;
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

export function modelChainFingerprint(
  modelChain: readonly string[],
  currentModel: Model<Api> | undefined,
): string {
  const currentKey = modelChain.includes(CURRENT_MODEL_REFERENCE)
    ? currentModel
      ? `${currentModel.provider}/${currentModel.id}`
      : "<none>"
    : undefined;
  return JSON.stringify({ modelChain, currentKey });
}

function modelReferenceKey(
  reference: string,
  currentModel: Model<Api> | undefined,
): string | undefined {
  if (reference === CURRENT_MODEL_REFERENCE) {
    return currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
  }
  const parsed = parseModelReference(reference);
  return parsed ? `${parsed.provider}/${parsed.modelId}` : undefined;
}

function describeModelReference(reference: string, currentModel: Model<Api> | undefined): string {
  if (reference !== CURRENT_MODEL_REFERENCE) return reference;
  return currentModel
    ? `${currentModel.provider}/${currentModel.id} ($current)`
    : "$current";
}

function describeNextReference(
  modelChain: readonly string[],
  index: number,
  currentModel: Model<Api> | undefined,
): string | undefined {
  const reference = modelChain[index];
  return reference === undefined ? undefined : describeModelReference(reference, currentModel);
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

function formatFailure(failure: ModelAttemptFailure): string {
  return `${failure.modelLabel}: ${failure.message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
