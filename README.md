# pi-lazy

Small Pi extension for context-aware cleanup of rough drafts before they are
submitted to the main agent.

It is useful for dictated text, hurried notes, typos, garbled technical names,
and awkward wording. Correction runs as a separate model request and returns
the result to Pi's editor for review. It does not add a main-conversation turn,
call tools, answer the draft, or submit anything automatically.

Requires Pi 0.80.4 or newer. Last verified with Pi 0.80.6.

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
  "model": "provider/model-id",
  "thinkingLevel": "off",
  "maxContextChars": 8000,
  "fallbackToCurrentModel": false
}
```

All fields are optional:

- `model` selects a correction model in `provider/model-id` form. Model IDs may
  contain additional `/` characters. Without this field, pi-lazy uses the
  current session model without changing it.
- `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
  `max`. It defaults to `off`, independently of the main session.
- `maxContextChars` sets the recent conversation-context budget from `0` through
  `100000`. It defaults to `8000`; `0` disables conversation context.
- `fallbackToCurrentModel` allows an unavailable configured model to fall back
  to the current session model after a visible warning. It defaults to `false`,
  preventing an unexpectedly expensive fallback from happening silently.

The selected model must exist in Pi's model registry and have usable credentials
through Pi. Unknown fields and invalid values are rejected.

## Context and privacy

pi-lazy uses Pi's compaction-aware active branch. Within the configured budget,
it includes recent user text, assistant text, compaction summaries, and branch
summaries. It excludes images, thinking, tool calls, tool results, shell output,
and extension state. Newest complete messages are preferred when the budget is
reached.

A configured correction model can use a provider different from the main
session provider. The rough draft and bounded conversation context are sent to
that provider. Configure only a provider appropriate for that content.

The correction prompt asks the model to make minimal edits while preserving
intent, facts, uncertainty, language, tone, named entities, terminology,
formatting, and formality. Model output can still be wrong; the result is always
returned to the editor for review and never submitted automatically.

## Install / try locally

Install the complete `pi-assorted` package from GitHub:

```bash
pi install git:github.com/7h145/pi-assorted
```

For a project-local install of only pi-lazy:

```bash
git clone https://github.com/7h145/pi-assorted
pi install ./pi-assorted/extensions/pi-lazy -l
```

To try this extension directly from the repository root:

```bash
pi -e ./extensions/pi-lazy
```

If `pi-assorted` is already installed, disable its installed pi-lazy copy with
`pi config`, or use `--no-extensions` for an isolated run, to avoid registering
`/lazy` twice. Run `/reload` after installing or updating while Pi is running.

For development, install only this extension's dev dependencies and run its
checks:

```bash
cd extensions/pi-lazy
npm install
npm run check
```

The local development dependencies are used for tests and type checking. Pi
provides the runtime `pi-ai` and `pi-coding-agent` packages.

## Notes

- Design rationale and maintenance constraints are in
  [`DEVELOPMENT.md`](./DEVELOPMENT.md).
- The bounded, ephemeral interaction was inspired by
  [`@narumitw/pi-btw`](https://www.npmjs.com/package/@narumitw/pi-btw), but
  pi-lazy does not depend on or import its implementation.
- pi-lazy is licensed under CC BY 4.0. See [`LICENSE`](./LICENSE).
