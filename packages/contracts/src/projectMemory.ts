import { NavigationSnapshot, NavigationTransition } from "./projectNavigation.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { QaRunId } from "./qaRuns.ts";

const PROJECT_MEMORY_FACT_KINDS = [
  "page",
  "control",
  "validation",
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
  stateId: MemoryText(200),
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
  stateId: Schema.String,
  stateName: Schema.String,
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
  query: Schema.optional(MemoryText(2000)),
  excludeVerdicts: Schema.optional(Schema.Boolean),
  stateId: Schema.optional(MemoryText(200)),
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
  "account",
  "instruction",
] as const;
export const ProjectUnderstandingKind = Schema.Literals(PROJECT_UNDERSTANDING_KINDS);
export type ProjectUnderstandingKind = typeof ProjectUnderstandingKind.Type;

/** How the user tests the project rather than how its app behaves; every thread starts with these. */
export const PROJECT_CONTEXT_KINDS = [
  "account",
  "instruction",
] as const satisfies ReadonlyArray<ProjectUnderstandingKind>;

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
  /** Earlier facts that a fact of this run restates in other words. */
  // Required in the model's schema (OpenAI strict output), defaulted when a reply leaves it out.
  replacedFacts: Schema.Array(
    Schema.Struct({ factId: Schema.String, byFactId: Schema.String }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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
  /** A fact it cites is no longer current. */
  needsReview: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProjectUnderstandingItem = typeof ProjectUnderstandingItem.Type;

export const ProjectMemoryMapPage = Schema.Struct({
  stateId: Schema.String,
  stateName: Schema.String,
  reachedBy: Schema.Array(Schema.String),
  environment: Schema.String,
  route: Schema.String,
  coverage: Schema.Literals(["failing", "tested", "seen"]),
  passCount: NonNegativeInt,
  failCount: NonNegativeInt,
  facts: Schema.Array(ProjectMemoryFact),
  details: Schema.Array(ProjectMemoryFact),
  needs: Schema.Array(Schema.String),
});
export type ProjectMemoryMapPage = typeof ProjectMemoryMapPage.Type;

export interface ProjectMemoryMapBranch {
  readonly name: string;
  readonly route: string;
  readonly page: ProjectMemoryMapPage | null;
  readonly children: ReadonlyArray<ProjectMemoryMapBranch>;
  readonly hiddenChildren: number;
}
interface ProjectMemoryMapBranchEncoded extends Omit<ProjectMemoryMapBranch, "page" | "children"> {
  readonly page: typeof ProjectMemoryMapPage.Encoded | null;
  readonly children: ReadonlyArray<ProjectMemoryMapBranchEncoded>;
}
export const ProjectMemoryMapBranch: Schema.Codec<
  ProjectMemoryMapBranch,
  ProjectMemoryMapBranchEncoded
> = Schema.Struct({
  name: Schema.String,
  route: Schema.String,
  page: Schema.NullOr(ProjectMemoryMapPage),
  children: Schema.Array(Schema.suspend(() => ProjectMemoryMapBranch)),
  hiddenChildren: NonNegativeInt,
});

export const ProjectMemoryMap = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environment: Schema.String,
      tree: ProjectMemoryMapBranch,
    }),
  ),
  hiddenEnvironments: NonNegativeInt,
  workflows: Schema.Array(
    Schema.Struct({
      itemId: Schema.String,
      statement: Schema.String,
      pages: Schema.Array(Schema.Struct({ environment: Schema.String, route: Schema.String })),
    }),
  ),
});
export type ProjectMemoryMap = typeof ProjectMemoryMap.Type;
export const ProjectMemoryMapInput = Schema.Struct({ projectId: ProjectId });

export const ProjectUnderstandingVersion = Schema.Struct({
  version: Schema.Int,
  kind: ProjectUnderstandingKind,
  statement: Schema.String,
  status: ProjectUnderstandingStatus,
  author: ProjectMemoryAuthor,
  citedFactIds: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  changedAt: Schema.String,
});
export type ProjectUnderstandingVersion = typeof ProjectUnderstandingVersion.Type;

export const ProjectMemoryStatus = Schema.Struct({
  recall: Schema.Literals(["semantic", "text"]),
  /** Why recall is text-only; null while semantic recall works. */
  recallNote: Schema.NullOr(Schema.String),
  pendingExtractions: NonNegativeInt,
  failedExtractions: Schema.Array(Schema.Struct({ runId: Schema.String, error: Schema.String })),
});
export type ProjectMemoryStatus = typeof ProjectMemoryStatus.Type;

export const ProjectMemorySnapshotInput = Schema.Struct({ projectId: ProjectId });

export const ProjectMemoryFactDeleteInput = Schema.Struct({
  projectId: ProjectId,
  factId: Schema.String,
});

export const ProjectUnderstandingHistoryInput = Schema.Struct({
  projectId: ProjectId,
  itemId: Schema.String,
});

/** The user rewrites or confirms an item; confirmed items are never revised by an agent. */
export const ProjectUnderstandingUpdateInput = Schema.Struct({
  projectId: ProjectId,
  itemId: Schema.String,
  statement: Schema.optional(MemoryText(2000)),
  confirm: Schema.optional(Schema.Boolean),
});

export const ProjectUnderstandingDeleteInput = Schema.Struct({
  projectId: ProjectId,
  itemId: Schema.String,
});

export const ProjectMemoryRetryInput = Schema.Struct({
  projectId: ProjectId,
  runId: Schema.String,
});

export const ProjectMemorySaveThreadInput = Schema.Struct({ threadId: ThreadId });
export const ProjectMemoryVersionInput = Schema.Struct({
  projectId: ProjectId,
  environment: MemoryText(2048),
  appVersion: MemoryText(100),
});

export const MemoryDocKind = Schema.Literals(["playbook", "guide"]);
export const MemorySlug = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/u));
export const MemoryDoc = Schema.Struct({
  docId: Schema.String,
  projectId: ProjectId,
  kind: MemoryDocKind,
  slug: MemorySlug,
  title: MemoryText(300),
  summary: Schema.String,
  environment: Schema.optional(Schema.String),
  status: Schema.Literals(["draft", "confirmed"]),
  routes: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  body: Schema.String,
  updatedAt: Schema.String,
});
export type MemoryDoc = typeof MemoryDoc.Type;
export const MemoryProposal = Schema.Struct({
  proposalId: Schema.String,
  projectId: ProjectId,
  targetDocId: Schema.String,
  kind: MemoryDocKind,
  title: Schema.String,
  proposedMarkdown: Schema.String,
  rationale: Schema.String,
  sourceRunId: Schema.optional(QaRunId),
  status: Schema.Literals(["pending", "approved", "dismissed"]),
  createdAt: Schema.String,
});
export type MemoryProposal = typeof MemoryProposal.Type;
/** Everything the Memory screen shows: every version of every fact, newest first. */
export const ProjectMemorySnapshot = Schema.Struct({
  navigation: Schema.optional(NavigationSnapshot),
  facts: Schema.Array(ProjectMemoryFact),
  /** More facts exist than were sent. */
  factsTruncated: Schema.Boolean,
  understanding: Schema.Array(ProjectUnderstandingItem),
  status: ProjectMemoryStatus,
  /** The playbook and guides. Optional so older servers still decode. */
  docs: Schema.optional(Schema.Array(MemoryDoc)),
  /** Drafts from finished runs waiting for the user's review. */
  proposals: Schema.optional(Schema.Array(MemoryProposal)),
  /** Current FAIL results, kept apart from the playbook and guides. */
  openIssues: Schema.optional(Schema.Array(ProjectMemoryFact)),
});
export type ProjectMemorySnapshot = typeof ProjectMemorySnapshot.Type;
/** A user edit; saved documents are confirmed, so agents never overwrite them. */
export const MemoryDocSaveInput = Schema.Struct({
  projectId: ProjectId,
  kind: MemoryDocKind,
  slug: MemorySlug,
  title: MemoryText(300),
  summary: Schema.String.check(Schema.isMaxLength(1000)),
  environment: Schema.optional(Schema.NullOr(MemoryText(2048))),
  routes: Schema.Array(MemoryText(2048)).check(Schema.isMaxLength(50)),
  keywords: Schema.Array(MemoryText(100)).check(Schema.isMaxLength(50)),
  body: Schema.String.check(Schema.isMaxLength(100_000)),
});
export const MemoryProposalApproveInput = Schema.Struct({
  projectId: ProjectId,
  proposalId: Schema.String,
  /** The user's explicit go-ahead to change a confirmed document. */
  replaceConfirmed: Schema.optional(Schema.Boolean),
});
export const MemoryProposalDismissInput = Schema.Struct({
  projectId: ProjectId,
  proposalId: Schema.String,
});
export const MemoryGetGuideInput = Schema.Struct({
  slug: MemorySlug,
  environment: Schema.optional(Schema.NullOr(MemoryText(2048))),
});
export const MemoryGetGuideResult = Schema.Struct({ guide: Schema.NullOr(MemoryDoc) });
export const MemorySearchInput = Schema.Struct({
  query: MemoryText(2000),
  environment: Schema.optional(Schema.NullOr(MemoryText(2048))),
});
export const MemoryForScreenInput = Schema.Struct({
  route: MemoryText(2048),
  environment: Schema.optional(Schema.NullOr(MemoryText(2048))),
});
export const MemorySearchResult = Schema.Struct({
  appliedEnvironment: Schema.optional(Schema.NullOr(Schema.String)),
  matchedCount: Schema.optional(Schema.Int),
  diagnosticNote: Schema.optional(Schema.String),
  docs: Schema.Array(MemoryDoc),
  facts: Schema.Array(ProjectMemoryFact),
});
export const MemoryForScreenResult = Schema.Struct({
  appliedEnvironment: Schema.optional(Schema.NullOr(Schema.String)),
  matchedCount: Schema.optional(Schema.Int),
  diagnosticNote: Schema.optional(Schema.String),
  guides: Schema.Array(MemoryDoc),
  facts: Schema.Array(ProjectMemoryFact),
  connections: Schema.Array(NavigationTransition),
  openIssuesLabel: Schema.Literal("Open issues from recent runs"),
  openIssues: Schema.Array(ProjectMemoryFact),
});
