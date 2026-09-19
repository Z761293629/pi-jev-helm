/**
 * THROWAWAY PROTOTYPE — validates an unsent Continuation Draft against Pi's
 * real agent_end -> agent_settled lifecycle. It performs no Jev request.
 *
 * Run:
 *   pi -e ./prototypes/completion-verification-v3/editor-draft-extension.ts
 *
 * Then:
 *   /helm-draft-demo arm
 *   <send any ordinary prompt and wait for it to settle>
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET = "helm-draft-demo";
const DRAFT = [
  "请继续检查并完成原请求中尚未覆盖或缺乏证据的部分。",
  "完成后只报告实际执行的工作、验证结果和仍存在的限制。",
].join("\n");

export default function editorDraftPrototype(pi: ExtensionAPI) {
  let armNextRun = false;
  let armedRun = false;
  let pendingDraft: string | undefined;

  const clearWidget = (ctx: ExtensionContext) => ctx.ui.setWidget(WIDGET, undefined);

  const offerDraft = (ctx: ExtensionContext): boolean => {
    if (!pendingDraft || ctx.mode !== "tui") return false;
    if (ctx.ui.getEditorText().length > 0) {
      ctx.ui.setWidget(WIDGET, [
        "helm draft · suggestion waiting; existing editor text was preserved",
        "run /helm-draft-demo apply after clearing the editor, or /helm-draft-demo clear",
      ]);
      return false;
    }
    ctx.ui.setEditorText(pendingDraft);
    pendingDraft = undefined;
    clearWidget(ctx);
    ctx.ui.notify("Helm draft loaded into the editor — edit, send, or delete it.", "info");
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    armNextRun = false;
    armedRun = false;
    pendingDraft = undefined;
    clearWidget(ctx);
  });

  pi.on("before_agent_start", async () => {
    if (!armNextRun) return;
    armedRun = true;
    armNextRun = false;
  });

  pi.on("agent_end", async () => {
    if (armedRun) pendingDraft = DRAFT;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!armedRun) return;
    armedRun = false;
    offerDraft(ctx);
  });

  pi.registerCommand("helm-draft-demo", {
    description: "Prototype an unsent Completion Verification continuation draft",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "arm") {
        armNextRun = true;
        ctx.ui.notify("Helm draft demo armed for the next ordinary prompt.", "info");
        return;
      }
      if (action === "apply") {
        if (!pendingDraft) {
          ctx.ui.notify("No Continuation Draft is waiting.", "info");
          return;
        }
        if (!offerDraft(ctx)) ctx.ui.notify("Editor text was preserved; clear it before applying the draft.", "warning");
        return;
      }
      if (action === "clear") {
        armNextRun = false;
        armedRun = false;
        pendingDraft = undefined;
        clearWidget(ctx);
        ctx.ui.notify("Helm draft demo cleared.", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(
          `Helm draft demo: ${armNextRun ? "armed for next run" : armedRun ? "waiting for settlement" : pendingDraft ? "draft waiting" : "idle"}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /helm-draft-demo arm|apply|clear|status", "error");
    },
  });
}
