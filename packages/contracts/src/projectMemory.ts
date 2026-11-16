import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { QaRunId } from "./qaRuns.ts";

const PROJECT_MEMORY_FACT_KINDS = [
  "page",
  "control",
  "validation",
  "navigation",
  "api",
  "result",
  "rule",
  "data",
] as const;
export const ProjectMemoryFactKind = Schema.Literals(PROJECT_MEMORY_FACT_KINDS);
export type ProjectMemoryFactKind = typeof ProjectMemoryFactKind.Type;

export const ProjectMemoryFactStatus = Schema.Literals([
  "current",
  "stale",
  "superseded",
  "contradicted",
]);
export type ProjectMemoryFactStatus = typeof ProjectMemoryFactStatus.Type;

export const ProjectMemoryAuthor = Schema.Literals(["server", "agent", "user"]);
export type ProjectMemoryAuthor = typeof ProjectMemoryAuthor.Type;

/** Points at a scenario's evidence in `qa-runs/`; memory never copies the evidence itself. */
export const ProjectMemoryEvidenceRef = Schema.Struct({
  threadId: ThreadId,
  runId: QaRunId,
  scenarioIndex: NonNegativeInt,
  type: Schema.Literals(["screenshot", "console", "network"]),
  /** One entry of the scenario's console or network log; the whole log when absent. */
  entryIndex: Schema.optional(NonNegativeInt),
});
export type ProjectMemoryEvidenceRef = typeof ProjectMemoryEvidenceRef.Type;

const MemoryText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ProjectMemoryFactInput = Schema.Struct({
  /** A URL or origin; stored as its origin. */
  environment: MemoryText(2048),
  /** A URL or path; stored as its path with ids and the query removed. */
  route: MemoryText(2048),
  kind: ProjectMemoryFactKind,
  key: MemoryText(200),
  value: MemoryText(500),
  detail: Schema.optional(MemoryText(2000)),
  pageUrl: Schema.optional(MemoryText(2048)),
  evidence: Schema.Array(ProjectMemoryEvidenceRef).check(Schema.isMaxLength(10)),
  appVersion: Schema.optional(MemoryText(100)),
  author: ProjectMemoryAuthor,
});
export type ProjectMemoryFactInput = typeof ProjectMemoryFactInput.Type;

export const ProjectMemoryFact = Schema.Struct({
  factId: Schema.String,
  projectId: ProjectId,
  environment: Schema.String,
  route: Schema.String,
  kind: ProjectMemoryFactKind,
  key: Schema.String,
  value: Schema.String,
  detail: Schema.NullOr(Schema.String),
  pageUrl: Schema.NullOr(Schema.String),
  evidence: Schema.Array(ProjectMemoryEvidenceRef),
  appVersion: Schema.NullOr(Schema.String),
  author: ProjectMemoryAuthor,
  status: ProjectMemoryFactStatus,
  observedAt: Schema.String,
  supersededBy: Schema.NullOr(Schema.String),
  /** Observed on another environment or app version than the one being tested now. */
  mayBeOutdated: Schema.Boolean,
});
export type ProjectMemoryFact = typeof ProjectMemoryFact.Type;

/** Exact-match filters; every field left out matches anything. */
export const ProjectMemoryFactLookup = Schema.Struct({
  environment: Schema.optional(MemoryText(2048)),
  route: Schema.optional(MemoryText(2048)),
  kind: Schema.optional(ProjectMemoryFactKind),
  key: Schema.optional(MemoryText(200)),
  /** Facts whose evidence points at this run. */
  runId: Schema.optional(QaRunId),
  /** Defaults to current facts. */
  status: Schema.optional(ProjectMemoryFactStatus),
  /** Only current results whose verdict is FAIL. */
  openFailures: Schema.optional(Schema.Boolean),
  /** What is being tested now, so facts from elsewhere are marked as maybe outdated. */
  testing: Schema.optional(
    Schema.Struct({
      environment: Schema.optional(MemoryText(2048)),
      appVersion: Schema.optional(MemoryText(100)),
    }),
  ),
  limit: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(500))),
});
export type ProjectMemoryFactLookup = typeof ProjectMemoryFactLookup.Type;

export class ProjectMemoryError extends Schema.TaggedError<ProjectMemoryError>()(
  "ProjectMemoryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const PROJECT_UNDERSTANDING_KINDS = [
  "workflow",
  "dependency",
  "test-strategy",
  "lesson",
  "open-question",
] as const;
export const ProjectUnderstandingKind = Schema.Literals(PROJECT_UNDERSTANDING_KINDS);
export type ProjectUnderstandingKind = typeof ProjectUnderstandingKind.Type;

/** Agents write hypotheses or verified items; only the user confirms. */
export const ProjectUnderstandingStatus = Schema.Literals(["hypothesis", "verified", "confirmed"]);
export type ProjectUnderstandingStatus = typeof ProjectUnderstandingStatus.Type;

/** What the extraction model returns. Kept loose so one bad item cannot fail the rest; the server validates each field. */
export const ProjectUnderstandingExtraction = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      /** An existing item's id to revise it, or a new label such as "new-1". */
      ref: Schema.String,
      kind: Schema.String,
      statement: Schema.String,
      citedFactIds: Schema.Array(Schema.String),
      /** Refs of the items this one depends on. */
      dependsOn: Schema.Array(Schema.String),
      /** A sentence the user wrote in this thread, copied exactly; null when none applies. */
      userQuote: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ProjectUnderstandingExtraction = typeof ProjectUnderstandingExtraction.Type;

export const ProjectUnderstandingItem = Schema.Struct({
  itemId: Schema.String,
  projectId: ProjectId,
  kind: ProjectUnderstandingKind,
  statement: Schema.String,
  status: ProjectUnderstandingStatus,
  author: ProjectMemoryAuthor,
  version: Schema.Int,
  citedFactIds: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProjectUnderstandingItem = typeof ProjectUnderstandingItem.Type;
