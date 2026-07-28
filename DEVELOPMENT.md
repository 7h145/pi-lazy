# pi-lazy development notes

This document records the design constraints and maintenance rationale that are
not obvious from the user-facing README. The original planning history remains
in [`PLAN.md`](./PLAN.md); this file should travel with the extension when it is
integrated into `7h145/pi-assorted`.

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

## Model policy

Without configuration, pi-lazy snapshots and uses the current session model. It
never calls `pi.setModel()` and does not alter the main session model.

An independent correction model may be selected in
`$PI_CODING_AGENT_DIR/pi-lazy.json`. It must exist in Pi's model registry and
have credentials resolvable through Pi. The configured thinking level is
independent of the main session and defaults to `off`.

An unavailable explicitly configured model fails closed by default. Optional
fallback to the current model must be enabled explicitly and must show a visible
warning. Never make fallback silent: it may unexpectedly select a slower, more
expensive, or externally hosted provider.

A different provider receives both the rough draft and bounded conversation
context. Keep this privacy consequence prominent in the README.

The completion uses `completeSimple()` from the public pi-ai compatibility entry
point and provides no tools. Only a response with stop reason `stop` and nonempty
text is accepted. Aborts, provider errors, truncated responses, tool-use stops,
and empty output are failures.

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
safety, minimal-edit prompt requirements, model selection and fallback,
completion outcomes, command registration, busy rejection, and editor
compare-and-set behavior.

Initial manual verification with Pi 0.80.6 covers:

- successful correction with the current model;
- correction through an independently configured model;
- provider failure with original-draft restoration;
- cancellation with original-draft restoration;
- loading the package through `pi --no-extensions -e .`.

When changing prompt wording, test ambiguous rough text as well as obvious typos.
Prompt tests can enforce instructions but cannot establish model behavior; retain
manual review-before-submit as a product invariant.

## pi-assorted maintenance checklist

When changing or releasing this extension in `7h145/pi-assorted`:

1. Preserve the entry-point Purpose, Strategy, Author, License, Version, Date,
   and Last-verified header.
2. Preserve CC BY 4.0 attribution and the pi-btw inspiration note.
3. Keep the root `pi.extensions` manifest and included-extension table current.
4. Keep runtime imports represented as optional peer dependencies; do not add a
   second Pi installation to production dependencies.
5. Run this extension's automated tests and type checking.
6. Verify direct loading and complete-package loading without duplicate command
   registration.
7. Re-run successful, failed, cancelled, and configured-model TUI checks after
   model, prompt, or lifecycle changes.
8. Update this document for compatibility or architectural decisions changed
   during maintenance.
