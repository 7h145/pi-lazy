/** pi-lazy
 *
 * Purpose: context-correct rough drafts in an isolated model call, then return
 * the corrected text to Pi's editor for review without adding a conversation
 * turn or submitting anything automatically.
 *
 * Strategy: build a small compaction-aware snapshot from the active branch,
 * use the current or independently configured model with reasoning off by
 * default, and treat editor replacement as a compare-and-set operation.
 * Inspired by the bounded, ephemeral interaction in @narumitw/pi-btw, without
 * depending on its private implementation.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.1
 * Date: 2026-07-27
 * Last verified with Pi: 0.80.6
 */

import {
  BorderedLoader,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings } from "./config.js";
import { buildConversationContext } from "./context.js";
import {
  resolveCorrectionModel,
  runCorrection,
  type CorrectionResult,
} from "./correction.js";

const COMMAND = "lazy";
const SETTINGS_FILE = "pi-lazy.json";

interface EditorUi {
  getEditorText(): string;
  setEditorText(text: string): void;
}

export default function piLazy(pi: ExtensionAPI): void {
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

      const resolution = await resolveCorrectionModel(
        settingsResult.settings,
        ctx.model,
        ctx.modelRegistry,
      );
      if (!resolution.ok) {
        restoreAfterFailure(ctx.ui, expectedEditorText, draft);
        ctx.ui.notify(`pi-lazy model error: ${resolution.error}`, "error");
        return;
      }
      if (resolution.warning) ctx.ui.notify(resolution.warning, "warning");

      const contextEntries = ctx.sessionManager.buildContextEntries();
      const conversationContext = buildConversationContext(
        contextEntries,
        settingsResult.settings.maxContextChars,
      );
      const modelLabel = `${resolution.model.provider}/${resolution.model.id}`;
      const result = await ctx.ui.custom<CorrectionResult>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, `Correcting draft with ${modelLabel}...`);
        let settled = false;

        loader.onAbort = () => {
          if (settled) return;
          settled = true;
          done({ kind: "cancelled" });
        };

        runCorrection({
          draft,
          conversationContext,
          model: resolution.model,
          auth: resolution.auth,
          thinkingLevel: settingsResult.settings.thinkingLevel,
          signal: loader.signal,
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
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });

        return loader;
      });

      if (result.kind === "corrected") {
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
