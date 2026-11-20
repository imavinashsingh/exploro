import { PreviewTabId } from "./preview.ts";
import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewAutomationAssertion } from "./previewAutomation.ts";
import { QaCheck } from "./qaRuns.ts";

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const Context = Schema.Record(Text(80), Text(160)).check(Schema.isMaxProperties(12));
export const NavigationState = Schema.Struct({
  id: Schema.String,
  environment: Schema.String,
  path: Schema.String,
  name: Text(160),
  aliases: Schema.Array(Text(160)).check(Schema.isMaxLength(10)),
  context: Context,
  checks: Schema.Array(QaCheck).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export type NavigationState = typeof NavigationState.Type;
export const NavigationTransition = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  action: Text(300),
  conditions: Context,
  runId: Schema.String,
  threadId: Schema.String,
  observedAt: Schema.String,
  available: Schema.Boolean,
});
export type NavigationTransition = typeof NavigationTransition.Type;
export const NavigationSnapshot = Schema.Struct({
  states: Schema.Array(NavigationState),
  transitions: Schema.Array(NavigationTransition),
  truncated: Schema.Boolean,
});
export type NavigationSnapshot = typeof NavigationSnapshot.Type;
export const NavigationObserveInput = Schema.Struct({
  name: Text(160),
  aliases: Schema.Array(Text(160)).check(Schema.isMaxLength(10)),
  context: Context,
  checks: Schema.Array(PreviewAutomationAssertion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  action: Schema.optional(Text(300)),
  tabId: Schema.optional(PreviewTabId),
});
export type NavigationObserveInput = typeof NavigationObserveInput.Type;
export const NavigationRouteInput = Schema.Struct({
  fromStateId: Schema.optional(Text(64)),
  destination: Text(160),
  tabId: Schema.optional(PreviewTabId),
});
export const NavigationRouteResult = Schema.Struct({
  status: Schema.Literals(["found", "already-there", "no-route", "ambiguous", "unrecognized"]),
  candidates: Schema.Array(NavigationState),
  directUrl: Schema.optional(Schema.String),
  steps: Schema.Array(
    Schema.Struct({ transition: NavigationTransition, destination: NavigationState }),
  ),
});
export type NavigationRouteResult = typeof NavigationRouteResult.Type;
export const NavigationDeleteInput = Schema.Struct({ projectId: ProjectId, id: Schema.String });
export const NavigationFeedbackInput = Schema.Struct({
  transitionId: Schema.String,
  outcome: Schema.Literals(["mismatch", "tool-error"]),
});
