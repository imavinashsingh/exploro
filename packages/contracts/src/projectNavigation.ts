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
  status: Schema.Literals([
    "found",
    "already-there",
    "no-route",
    "ambiguous",
    "unrecognized",
    "budget-exhausted",
  ]),
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

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PageLimit = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));
const Cursor = Schema.optional(Text(4096));
export const NavigationSummary = Schema.Struct({
  hasNeedsRecheck: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  environment: Schema.String,
  path: Schema.String,
  incomingCount: Count,
  outgoingCount: Count,
});
export type NavigationSummary = typeof NavigationSummary.Type;
export const NavigationOverviewInput = Schema.Struct({ projectId: ProjectId });
export const NavigationOverview = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      environment: Schema.String,
      pathGroup: Schema.String,
      stateCount: Count,
      incomingCount: Count,
      outgoingCount: Count,
    }),
  ),
  connections: Schema.Array(
    Schema.Struct({
      fromEnvironment: Schema.String,
      fromPathGroup: Schema.String,
      toEnvironment: Schema.String,
      toPathGroup: Schema.String,
      count: Count,
    }),
  ),
  limit: Count,
  truncated: Schema.Boolean,
});
export const NavigationChildrenInput = Schema.Struct({
  projectId: ProjectId,
  environment: Schema.String,
  pathGroup: Schema.String,
  prefix: Schema.optional(Schema.String),
  cursor: Cursor,
  limit: PageLimit(200),
});
export const NavigationStatePage = Schema.Struct({
  states: Schema.Array(NavigationSummary),
  nextCursor: Schema.NullOr(Schema.String),
  limit: Count,
  truncated: Schema.Boolean,
});
// Subgroups have no cursor. State cursors are opaque and scoped to environment, group and prefix.
export const NavigationChildren = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("subgroups"),
    subgroups: Schema.Array(
      Schema.Struct({ prefix: Schema.String, stateCount: Count, countCapped: Schema.Boolean }),
    ),
    states: Schema.Array(NavigationSummary),
    nextCursor: Schema.Null,
    limit: Count,
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("states"),
    ...NavigationStatePage.fields,
    connections: Schema.Array(NavigationTransition),
    connectionsTruncated: Schema.Boolean,
  }),
]);
export const NavigationNeighborhoodInput = Schema.Struct({
  projectId: ProjectId,
  stateId: Schema.String,
  limit: PageLimit(200),
  filter: Schema.optional(Schema.Literals(["available", "needs-recheck", "all"])),
});
const Neighbor = Schema.Struct({ transition: NavigationTransition, state: NavigationSummary });
export const NavigationNeighborhood = Schema.Struct({
  state: Schema.NullOr(NavigationSummary),
  incoming: Schema.Array(Neighbor),
  outgoing: Schema.Array(Neighbor),
  incomingTruncated: Schema.Boolean,
  outgoingTruncated: Schema.Boolean,
  limit: Count,
  truncated: Schema.Boolean,
});
export const NavigationSearchInput = Schema.Struct({
  projectId: ProjectId,
  query: Text(160),
  cursor: Cursor,
  limit: PageLimit(50),
});
export const NavigationDetailsInput = Schema.Struct({
  projectId: ProjectId,
  stateId: Schema.String,
});
export const NavigationDetails = Schema.Struct({
  needsRecheckCount: Count,
  state: Schema.NullOr(NavigationState),
  incomingCount: Count,
  outgoingCount: Count,
  runs: Schema.Array(
    Schema.Struct({ runId: Schema.String, threadId: Schema.String, observedAt: Schema.String }),
  ),
  limit: Count,
  truncated: Schema.Boolean,
});
export const NavigationRoutePreviewInput = Schema.Struct({
  projectId: ProjectId,
  fromStateId: Schema.String,
  toStateId: Schema.String,
});
export const NavigationRoutePreview = Schema.Struct({
  status: Schema.Literals(["found", "already-there", "no-route", "budget-exhausted"]),
  steps: Schema.Array(
    Schema.Struct({ transition: NavigationTransition, destination: NavigationSummary }),
  ),
  limit: Count,
  truncated: Schema.Boolean,
});

export const NavigationRevision = Schema.Struct({
  revision: Count,
  clusters: Schema.Array(
    Schema.Struct({ environment: Schema.String, pathGroup: Schema.String }),
  ).check(Schema.isMaxLength(50)),
  stateIds: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
  all: Schema.Boolean,
});
export type NavigationRevision = typeof NavigationRevision.Type;
