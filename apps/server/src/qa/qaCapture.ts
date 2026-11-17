import type { PreviewAutomationSnapshot, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { QaPageCapture } from "./QaRuns.ts";

// Inline styles, not a <style> tag, so a strict page CSP cannot block the mask.
const MASK_PASSWORDS = `(() => {
  const masked = [];
  for (const input of document.querySelectorAll('input[type="password"]')) {
    masked.push([input, input.getAttribute("style")]);
    input.style.setProperty("color", "transparent", "important");
    input.style.setProperty("text-shadow", "none", "important");
    input.style.setProperty("-webkit-text-security", "none", "important");
  }
  globalThis.__exploroQaPasswordMask = masked;
  return masked.length;
})()`;
const UNMASK_PASSWORDS = `(() => {
  for (const [input, style] of globalThis.__exploroQaPasswordMask ?? []) {
    if (style === null) input.removeAttribute("style");
    else input.setAttribute("style", style);
  }
  delete globalThis.__exploroQaPasswordMask;
  return true;
})()`;

const decodePng = (data: string | undefined) =>
  data === undefined || data.length === 0 ? null : new Uint8Array(Buffer.from(data, "base64"));

/** What the tab shows now, for a scenario's evidence. Saved evidence outlives the turn, so
 * password fields are blanked, not just dotted. The full-resolution capture is for people. */
export const capturePage = (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  scope: McpInvocationContext.McpThreadInvocationScope,
  tabId: PreviewTabId | undefined,
) => {
  const tab = tabId === undefined ? {} : { tabId };
  const evaluate = (expression: string) =>
    broker
      .invoke({ scope, operation: "evaluate", input: { expression, ...tab }, ...tab })
      .pipe(Effect.ignore);
  return evaluate(MASK_PASSWORDS).pipe(
    Effect.andThen(
      broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: { fullScreenshot: true },
        ...tab,
      }),
    ),
    Effect.ensuring(evaluate(UNMASK_PASSWORDS)),
    Effect.map((snapshot): QaPageCapture => ({
      url: snapshot.url,
      title: snapshot.title,
      png: decodePng(snapshot.fullScreenshot?.data ?? snapshot.screenshot.data),
      consoleEntries: snapshot.consoleEntries,
      networkEntries: snapshot.networkEntries,
      actionTimeline: snapshot.actionTimeline,
    })),
  );
};
