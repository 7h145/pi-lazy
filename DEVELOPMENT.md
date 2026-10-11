# pi-lazy development notes

This document records the design constraints and maintenance rationale that are
not obvious from the user-facing README.

## Compatibility and modernization

pi-lazy remains available but is no longer actively developed; new correction
work happens in [pi-oaistt](https://github.com/7h145/pi-oaistt). Its distinguishing
feature remains that it does not replace Pi's editor. The modernization described
below has not been implemented.

### Compatibility baseline

The correction layer has known compatibility gaps with Pi 1.0.2 and 1.1.0.
Against both package versions, all 69 existing unit tests pass, but type checking
fails. The development dependencies in `package.json` still pin Pi packages to
0.80.6, so the normal `npm run check` does not establish compatibility with these
newer versions. The last documented manual TUI verification remains Pi 0.82.1.

The command and UI integration still use supported public APIs: command
registration, `ctx.mode`, `ctx.isIdle()`, compaction-aware context extraction,
`BorderedLoader`, custom UI, and editor access. The problems are concentrated in
`src/correction.ts`:

- **Legacy request dispatch.** The default completion imports `completeSimple()`
  from `@earendil-works/pi-ai/compat`. That entry point is explicitly temporary
  and scheduled for removal. It dispatches through the old API registry rather
  than Pi's configured provider runtime. A synthetic native provider works
  through Pi's model registry but fails through pi-lazy with
  `No API provider registered for api`. Existing injected-completion unit tests
  do not cover this integration boundary.
- **Outdated auth types.** `RequestAuth.headers` permits only string values, while
  current Pi permits `string | null`; `null` suppresses a header. This makes
  `ModelRegistryLike` incompatible with Pi's `ModelRegistry`, producing a
  TypeScript error where `src/index.ts` passes `ctx.modelRegistry` to the chain.
  Pi transpiles extensions when loading them, so this error alone does not imply
  that a running extension cannot work.
- **Discarded auth-derived endpoint.** `authenticate()` copies the resolved API
  key, headers and environment but drops the optional `baseUrl`. A synthetic
  provider confirms that Pi's registry request path preserves this endpoint
  override while pi-lazy discards it. This concerns endpoints resolved during
  authentication, such as account-specific endpoints, not every custom URL.
  An ordinary `models.json` endpoint already carried in `model.baseUrl` is passed
  through unchanged and can work correctly, including local OpenAI-compatible
  endpoints. No failure of such a configured endpoint is established here.

These findings are not a claim that every existing configuration is broken or
that a working installation requires an urgent repair. Passing the unit tests
also does not establish full current-Pi compatibility.

### Migration scope

This should be a focused correction-layer change, not an editor or architecture
rewrite. Preserve the design invariants below and the existing model-chain,
privacy, cancellation and editor-delivery contracts.

1. Choose the supported Pi version range before changing dependencies. The
   advertised minimum is currently 0.80.4. Check whether the replacement APIs
   exist at the chosen minimum; either retain and test that compatibility or
   raise the minimum in the peer dependencies and README. Do not assume that
   testing 1.0.2 and 1.1.0 establishes compatibility with older releases.
2. Keep candidate lookup through Pi's registry, but execute each isolated request
   with `registry.streamSimple(model, context, options).result()`. Supply the
   correction prompt, draft/context snapshot, configured reasoning and the
   loader's abort signal, but no tools. Let Pi handle provider dispatch and
   request-time authentication, including endpoint and header overrides.
3. Remove the compatibility completion import and manual auth-copying path.
   Adapt the narrow registry interface and keep a testable completion seam
   without duplicating Pi's auth types. Normalize thrown failures and terminal
   error/abort responses into the existing chain outcomes. Authentication
   failures must still trigger fallback; cancellation must stop the chain without
   advancing its remembered position.
4. Update the pinned development packages to the chosen baseline, adapt the tests,
   and test the supported range. Update compatibility claims and verification
   metadata only after the corresponding checks, especially manual TUI checks.

Start with Pi's [extension context guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#use-extension-context),
[custom-provider contracts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md),
and [pi-ai migration guidance](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#migrating-from-the-old-global-api).
The shipped `examples/extensions/qna.ts` demonstrates an isolated registry-backed
completion inside `BorderedLoader`. Consult the declarations and examples shipped
with the actual target Pi version; upstream `main` can change.

### Validation needed for a migration

Run the existing unit tests and type checking with the target Pi packages, then
add registry-backed tests using synthetic providers and in-memory credentials.
Cover native-provider dispatch, auth-derived endpoints, nullable headers,
authentication failure and cancellation during authentication. Pi AI's
`fauxProvider()` and Pi's `ModelRuntime`/`ModelRegistry` are useful fixtures for
exercising the real dispatch path without HTTP. Isolate the agent directory and
environment too: in-memory credentials alone do not prevent ambient environment
lookup. These tests should make no live provider requests or read production
credentials.

Keep existing coverage and extend it where needed for ordered fallback, sticky
candidate reuse and resets, all-candidate exhaustion, immutable draft/context
snapshots, independent reasoning, empty/truncated/error responses, busy rejection,
and editor compare-and-set writes.
The request must contain no tools and must not add a main-conversation turn or
change the main model.

Manual testing remains necessary because mocked UI tests do not establish TUI
behavior. Load the checkout with `pi --no-extensions -e .` and verify:

- successful correction using the current model and an explicitly configured
  OpenAI-compatible endpoint;
- provider failure followed by fallback, then sticky reuse on the next command;
- all providers failing, with original-draft restoration and fail-fast behavior;
- Escape cancellation, with original-draft restoration;
- successful output returning to the editor without automatic submission or a
  new main-conversation turn;
- preservation of a newer editor draft, busy-command restoration, and health-state
  reset after reload or session replacement.

A focused provider smoke test is sufficient for this migration; an exhaustive
live-provider matrix is not implied. Automated registry tests and manual TUI
checks serve different purposes, and both are needed before claiming compatibility.

## Design invariants

pi-lazy is an editor filter, not another agent turn.

- A correction request must not add messages or extension entries to the main
  conversation.
- The correction model must not receive tools or act on the draft.
- Successful output must return to Pi's editor for user review.
- Output must never be submitted automatically.
- The model should make minimal corrections and preserve intent, facts,
  uncertainty, language, grammatical person, tone, named entities, technical
  terminology, formatting, and formality.
- Cancellation or failure should not silently lose the original draft.
- A completed correction must not overwrite editor text created concurrently.

These properties are more important than reducing a few lines of implementation
or making `/lazy` behave like a normal prompt.

## Architecture

The implementation is intentionally split into independently testable layers:

- `src/config.ts` loads and strictly validates `pi-lazy.json` on every command.
- `src/context.ts` extracts and budgets useful text from Pi's active context.
- `src/prompt.ts` defines the fixed correction contract and safely serializes
  context and draft text.
- `src/correction.ts` resolves a model and credentials, performs the isolated
  completion, and normalizes its outcome.
- `src/index.ts` owns `/lazy`, TUI progress and cancellation, busy-agent policy,
  notifications, and safe editor delivery.

Keep the idle check and other Pi lifecycle policy in `index.ts`. The lower
layers should continue to operate on immutable inputs without querying or
mutating the active agent.

## Why this is independent of pi-btw

The first `stt-correct` prototype deep-imported context and completion helpers
from `@narumitw/pi-btw`. pi-btw demonstrated that a bounded, ephemeral,
context-aware interaction works well, but its private source paths and side
question semantics are not a suitable production dependency.

pi-lazy therefore uses only public APIs from `@earendil-works/pi-coding-agent`
and `@earendil-works/pi-ai`. Do not reintroduce a deep import or installation
path dependency on pi-btw.

## Context policy

`ctx.sessionManager.buildContextEntries()` supplies the compaction-aware active
branch. pi-lazy includes:

- user text;
- assistant text;
- compaction summaries;
- branch summaries.

It excludes:

- thinking blocks;
- images and encoded image data;
- tool calls and tool results;
- shell output;
- custom extension messages and state;
- model and thinking-level metadata.

The exclusions keep routine corrections small and prevent high-volume tool data
from dominating linguistic context. Reconsider them only with evidence that a
specific excluded source improves correction enough to justify its token and
privacy cost.

The default budget is 8,000 Unicode code points and is configurable up to
100,000. Selection proceeds from newest eligible messages backward, preferring
complete messages. If the newest message alone is too large, its tail is kept
with an omission marker.

The request puts conversation context before the changing draft. This preserves
a potentially reusable provider prefix and avoids pi-btw's side-question layout,
where unique question text precedes context. Provider caching is an optimization
possibility, not a behavioral guarantee.

Context and draft are encoded as JSON strings with tag-significant characters
escaped. They remain untrusted user content rather than system instructions.

## Model-chain policy

`modelChain` is an ordered, nonempty list of explicit `provider/model-id`
references and the reserved `"$current"` entry. Without configuration, it
defaults to `["$current"]`. pi-lazy snapshots the current model when invoked,
never calls `pi.setModel()`, and does not alter the main session model.

Candidates are resolved lazily. Missing models, credential failures, thrown
connection errors, provider errors, truncated responses, tool-use stops, and
empty output all advance to the next candidate. Cancellation stops immediately
without advancing persistent health state. Every transition must show a warning
because it may select a slower, more expensive, or externally hosted provider.

All attempts use the same immutable draft and context snapshot. The configured
thinking level applies to every candidate, is independent of the main session,
and defaults to `off`. Every attempted provider receives both the draft and
bounded context; keep this privacy consequence prominent in the README.

The first candidate that succeeds becomes the minimum candidate index for the
current extension runtime. Earlier failed candidates are skipped on later
commands, preventing repeated timeout costs. The index moves only forward. If a
remembered candidate later fails and a later one succeeds, the later candidate
becomes sticky. If all remaining candidates fail, later commands fail fast
until reset.

The health position resets when the extension reloads or its session runtime is
replaced. It also resets when the configured chain changes, or when the current
model changes while `"$current"` appears in the chain. Runtime deduplication
prevents an explicit model reference and `"$current"` from invoking the same
resolved model twice.

The completion uses `completeSimple()` from the public pi-ai compatibility entry
point and provides no tools. Only a response with stop reason `stop` and nonempty
text is accepted.

## Editor and TUI safety

Submitting an extension command normally clears its text from Pi's editor.
`src/index.ts` captures the expected post-dispatch editor state and treats every
write as compare-and-set:

```text
write replacement only if current editor text still equals expected text
```

On successful correction, the replacement is the corrected draft. On
cancellation or model/configuration failure, the replacement is the original
rough draft. If the editor changed, pi-lazy leaves it untouched and warns rather
than overwriting it.

The correction loader owns its own abort signal. Do not use the main agent's
signal for the side request; the two operations have different cancellation
semantics.

## Busy-agent behavior and future concurrency

The current release rejects `/lazy` while the main agent is busy. It makes no
correction request and safely restores the complete `/lazy <draft>` command so
Enter can retry it after Pi settles.

This is deliberately an orchestration policy rather than a correction-engine
assumption. Future concurrent correction should remain additive. It will need
to:

- snapshot only context committed when `/lazy` is invoked;
- exclude partial in-flight assistant output;
- use a correction-specific abort signal;
- tolerate simultaneous main-agent TUI updates;
- preserve editor compare-and-set delivery;
- handle reload, shutdown, and session replacement during the request;
- test simultaneous provider calls and editor races explicitly.

A future strict configuration value could be
`busyBehavior: "reject" | "concurrent"`. Do not expose that setting before the
concurrent path is implemented and tested.

## Tests and verification

Run:

```bash
npm run typecheck
npm test
npm run check
```

The unit tests cover configuration, context extraction and budgeting, delimiter
safety, minimal-edit prompt requirements, ordered model fallback, runtime
failures, sticky candidate indexing, completion outcomes, command registration,
busy rejection, and editor compare-and-set behavior.

Manual verification through Pi 0.82.1 covers:

- successful correction with the current model;
- correction through an independently configured model;
- runtime fallback after a provider failure;
- sticky reuse of the first successful fallback without retrying earlier models;
- provider failure with original-draft restoration;
- cancellation with original-draft restoration;
- loading the package through `pi --no-extensions -e .`.

When changing prompt wording, test ambiguous rough text as well as obvious typos.
Prompt tests can enforce instructions but cannot establish model behavior; retain
manual review-before-submit as a product invariant.

## Maintenance checklist

When changing or releasing `7h145/pi-lazy`:

1. Preserve the entry-point Purpose, Strategy, Author, License, Version, Date,
   and Last-verified header.
2. Preserve MIT licensing, source attribution, and the pi-btw inspiration note.
3. Keep the `pi.extensions` manifest and README current.
4. Keep runtime imports represented as optional peer dependencies; do not add a
   second Pi installation to production dependencies.
5. Run this extension's automated tests and type checking.
6. Verify direct-file and package loading without duplicate command registration.
7. Re-run successful, failed, cancelled, and configured-model TUI checks after
   model, prompt, or lifecycle changes.
8. Update this document for compatibility or architectural decisions changed
   during maintenance.
