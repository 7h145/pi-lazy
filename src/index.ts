/** pi-lazy
 *
 * Purpose: context-correct rough drafts in an isolated model call, then return
 * the corrected text to Pi's editor for review without adding a conversation
 * turn or submitting anything automatically.
 *
 * Strategy: build a small compaction-aware snapshot from the active branch,
 * try an ordered model chain with reasoning off by default, remember the first
 * working candidate for the current extension runtime, and treat editor
 * replacement as a compare-and-set operation. Inspired by the bounded,
 * ephemeral interaction in @narumitw/pi-btw, without depending on its private
 * implementation.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.2
 * Date: 2026-07-28
 * Last verified with Pi: 0.82.1
 */

import {
  BorderedLoader,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { CURRENT_MODEL_REFERENCE, loadSettings } from "./config.js";
import { buildConversationContext } from "./context.js";
import {
  modelChainFingerprint,
  runCorrectionChain,
  type CorrectionChainResult,
} from "./correction.js";

const COMMAND = "lazy";
const SETTINGS_FILE = "pi-lazy.json";

type UiCorrectionResult =
  | CorrectionChainResult
  | { kind: "internalError"; message: string };

interface EditorUi {
  getEditorText(): string;
  setEditorText(text: string): void;
}

export default function piLazy(pi: ExtensionAPI): void {
  let activeChainFingerprint: string | undefined;
  let minimumCandidateIndex = 0;

  pi.registerCommand(COMMAND, {
    description: "Context-correct a rough draft and return it to the editor",
    handler: async (args, ctx) => {
      const draft = args.trim();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/lazy requires interactive TUI mode", "error");
        return;
      }
      if (!draft) {
        ctx.ui.notify("Usage: /lazy <draft>", "warning");
        return;
      }

      const expectedEditorText = ctx.ui.getEditorText();
      if (!ctx.isIdle()) {
        const restored = replaceEditorIfUnchanged(
          ctx.ui,
          expectedEditorText,
          `/${COMMAND} ${draft}`,
        );
        ctx.ui.notify(
          restored
            ? "Pi is busy. The /lazy command was restored; retry when Pi settles."
            : "Pi is busy. The editor changed, so /lazy did not overwrite it.",
          "warning",
        );
        return;
      }

      const settingsPath = join(getAgentDir(), SETTINGS_FILE);
      const settingsResult = await loadSettings(settingsPath);
      if (!settingsResult.ok) {
        restoreAfterFailure(ctx.ui, expectedEditorText, draft);
        ctx.ui.notify(`pi-lazy settings error: ${settingsResult.error}`, "error");
        return;
      }

      const settings = settingsResult.settings;
      const fingerprint = modelChainFingerprint(settings.modelChain, ctx.model);
      if (fingerprint !== activeChainFingerprint) {
        activeChainFingerprint = fingerprint;
        minimumCandidateIndex = 0;
      }

      if (minimumCandidateIndex >= settings.modelChain.length) {
        restoreAfterFailure(ctx.ui, expectedEditorText, draft);
        ctx.ui.notify(
          "No usable correction model remains. Run /reload to retry the model chain.",
          "error",
        );
        return;
      }

      const contextEntries = ctx.sessionManager.buildContextEntries();
      const conversationContext = buildConversationContext(
        contextEntries,
        settings.maxContextChars,
      );
      const firstReference = settings.modelChain[minimumCandidateIndex];
      const firstLabel = describeReference(firstReference, ctx.model);
      const result = await ctx.ui.custom<UiCorrectionResult>(
        (tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Correcting draft with ${firstLabel}...`,
          );
          let settled = false;

          loader.onAbort = () => {
            if (settled) return;
            settled = true;
            done({ kind: "cancelled" });
          };

          runCorrectionChain({
            modelChain: settings.modelChain,
            startIndex: minimumCandidateIndex,
            currentModel: ctx.model,
            registry: ctx.modelRegistry,
            draft,
            conversationContext,
            thinkingLevel: settings.thinkingLevel,
            signal: loader.signal,
            onFailure: (failure, nextModelLabel) => {
              if (!nextModelLabel) return;
              ctx.ui.notify(
                `Correction with ${failure.modelLabel} failed: ${failure.message}; trying ${nextModelLabel}.`,
                "warning",
              );
            },
          })
            .then((correction) => {
              if (settled) return;
              settled = true;
              done(correction);
            })
            .catch((error: unknown) => {
              if (settled) return;
              settled = true;
              done({
                kind: "internalError",
                message: error instanceof Error ? error.message : String(error),
              });
            });

          return loader;
        },
      );

      if (result.kind === "corrected") {
        const previousCandidateIndex = minimumCandidateIndex;
        minimumCandidateIndex = result.candidateIndex;
        if (result.candidateIndex > previousCandidateIndex) {
          ctx.ui.notify(
            `Using ${result.modelLabel} for /lazy until /reload or session replacement.`,
            "warning",
          );
        }

        if (replaceEditorIfUnchanged(ctx.ui, expectedEditorText, result.text)) {
          ctx.ui.notify("Corrected draft loaded. Review and submit when ready.", "info");
        } else {
          ctx.ui.notify(
            "Correction completed, but the editor changed, so pi-lazy did not overwrite it.",
            "warning",
          );
        }
        return;
      }

      if (result.kind === "exhausted") minimumCandidateIndex = settings.modelChain.length;
      const restored = restoreAfterFailure(ctx.ui, expectedEditorText, draft);
      if (result.kind === "cancelled") {
        ctx.ui.notify(
          restored
            ? "Correction cancelled; original draft restored."
            : "Correction cancelled; the changed editor was left untouched.",
          "info",
        );
      } else {
        ctx.ui.notify(
          `Correction failed: ${result.message}${restored ? "; original draft restored" : "; changed editor left untouched"}.`,
          "error",
        );
      }
    },
  });
}

export function replaceEditorIfUnchanged(
  ui: EditorUi,
  expectedText: string,
  replacement: string,
): boolean {
  if (ui.getEditorText() !== expectedText) return false;
  ui.setEditorText(replacement);
  return true;
}

function restoreAfterFailure(ui: EditorUi, expectedText: string, draft: string): boolean {
  return replaceEditorIfUnchanged(ui, expectedText, draft);
}

function describeReference(
  reference: string | undefined,
  currentModel: { provider: string; id: string } | undefined,
): string {
  if (reference !== CURRENT_MODEL_REFERENCE) return reference ?? "unknown model";
  return currentModel
    ? `${currentModel.provider}/${currentModel.id} ($current)`
    : CURRENT_MODEL_REFERENCE;
}
