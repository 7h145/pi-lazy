# pi-lazy

Small Pi extension for context-aware cleanup of rough drafts before they are
submitted to the main agent.

It is useful for dictated text, hurried notes, typos, garbled technical names,
and awkward wording. Correction runs as a separate model request and returns
the result to Pi's editor for review. It does not add a main-conversation turn,
call tools, answer the draft, or submit anything automatically.

Requires Pi 0.80.4 or newer. Last verified with Pi 0.82.1.

## Maintenance status

New draft-correction development happens in
[`pi-oaistt`](https://github.com/7h145/pi-oaistt), which also provides dictation
and correction while the main agent is busy. pi-lazy remains available, but is
no longer actively developed.

Unlike pi-oaistt, pi-lazy does not replace Pi's editor. It remains an alternative
when you need another editor extension or prefer the `/lazy` command.

## Command

```text
/lazy <rough draft>
```

For dictation, type `/lazy ` first, dictate or paste text after the prefix, and
press Enter. Review the corrected draft returned to the editor, then edit it
further or submit it manually.

If the main agent is busy, pi-lazy makes no correction request and restores the
complete `/lazy <draft>` command. Press Enter again after Pi settles. A cancelled
or failed correction restores the original draft when the editor has not
changed. pi-lazy never overwrites a newer editor draft.

## Configuration

Configuration is optional. pi-lazy reads this file on every invocation, so
changes apply without `/reload`:

```text
$PI_CODING_AGENT_DIR/pi-lazy.json
```

The normal location is `~/.pi/agent/pi-lazy.json`.

```json
{
  "modelChain": [
    "openai.lcl.example/chat-flash",
    "openai-codex/gpt-5.6-luna",
    "$current"
  ],
  "thinkingLevel": "off",
  "maxContextChars": 8000
}
```

All fields are optional. Version 0.2 replaces the earlier `model` and
`fallbackToCurrentModel` fields with `modelChain`; the removed fields are
rejected by strict configuration validation.

- `modelChain` is a nonempty ordered list. Each entry is a
  `provider/model-id` reference or `"$current"`, meaning the current Pi session
  model. The first entry is preferred and later entries are fallbacks. It
  defaults to `["$current"]`; omit `"$current"` to prevent fallback to the main
  model. Model IDs may contain additional `/` characters.
- `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
  `max`. It defaults to `off`, independently of the main session.
- `maxContextChars` sets the recent conversation-context budget from `0` through
  `100000`. It defaults to `8000`; `0` disables conversation context.

Each candidate is resolved lazily and must exist in Pi's model registry with
usable credentials. Use `pi --list-models` to list available model strings, or
`pi --list-models <search>` to narrow the results (for example,
`pi --list-models openai-codex`). Copy the displayed `provider/model` pair into
`modelChain`. Pi's `/model` command or Ctrl+L provides the same discovery flow
interactively.

On any non-cancellation failure, pi-lazy warns and tries the next candidate with
the same draft and context snapshot. Cancellation stops the chain immediately.

After a fallback succeeds, pi-lazy remembers that candidate and skips earlier
failed models for the rest of the current extension runtime. This avoids paying
repeated connection-timeout costs. `/reload`, session replacement, a changed
model chain, or a changed session model referenced by `"$current"` resets the
remembered position. If every candidate fails, later calls fail immediately
until reset. Unknown fields, duplicate candidates, and invalid values are
rejected.

## Context and privacy

pi-lazy uses Pi's compaction-aware active branch. Within the configured budget,
it includes recent user text, assistant text, compaction summaries, and branch
summaries. It excludes images, thinking, tool calls, tool results, shell output,
and extension state. Newest complete messages are preferred when the budget is
reached.

Model-chain candidates can use providers different from the main session
provider. Every attempted provider receives the rough draft and bounded
conversation context. Configure only providers appropriate for that content.

The correction prompt asks the model to make minimal edits while preserving
intent, facts, uncertainty, language, tone, named entities, terminology,
formatting, and formality. Model output can still be wrong; the result is always
returned to the editor for review and never submitted automatically.

## Installation

Install this extension from GitHub:

```bash
pi install git:github.com/7h145/pi-lazy
```

This is a personal/global install. Add `-l` for a project-local install.
Run `/reload` after installing or updating while Pi is running.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, avoiding duplicate registration of
`/lazy`.

For development, install the dev dependencies and run the checks from the
checkout's root:

```bash
npm install
npm run check
```

The local development dependencies are used for tests and type checking. Pi
provides the runtime `pi-ai` and `pi-coding-agent` packages.

### Migrating from pi-assorted

If you have the legacy [`pi-assorted`](https://github.com/7h145/pi-assorted)
collection installed, turn off its pi-lazy extension before installing this
standalone version. Otherwise Pi will try to load the same extension twice.

Run `pi config` in a terminal. Under the `pi-assorted` package's Extensions
entries, select `src/index.ts` and press Space to uncheck it
(`[ ]`). Changes are saved immediately; press Esc to close.

For a project-local collection installation, run `pi config -l` from that
project and press Space until the entry shows `[-]` (project unload).

See Pi's [resource settings reference](https://pi.dev/docs/latest/settings#resources)
for configuration details.

## Notes

- Design rationale and maintenance constraints are in
  [`DEVELOPMENT.md`](./DEVELOPMENT.md).
- The bounded, ephemeral interaction was inspired by
  [`@narumitw/pi-btw`](https://www.npmjs.com/package/@narumitw/pi-btw), but
  pi-lazy does not depend on or import its implementation.
- pi-lazy is licensed under MIT. See [`LICENSE`](./LICENSE).
