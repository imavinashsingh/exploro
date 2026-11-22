import {
  ProjectMemoryError,
  ProjectMemoryEvidenceRef,
  ProjectMemoryAuthor,
  ProjectMemoryFactKind,
  ProjectMemoryFactStatus,
  ProjectId,
  QaRun,
  type ProjectMemoryMap,
  type ThreadId,
  type MemoryBriefUsage,
  type ProjectMemoryFact,
  type ProjectMemoryFactInput,
  type ProjectMemoryFactLookup,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import { buildProjectMap } from "./projectMap.ts";

import * as ServerConfig from "../config.ts";
import { hideProvidedSecrets } from "./providedSecrets.ts";
import { qaThreadFolder } from "../qa/qaEvidence.ts";
import * as Option from "effect/Option";
import * as ProjectNavigationMemory from "./ProjectNavigationMemory.ts";
import { bumpNavigationRevision } from "./navigationRevision.ts";
import { forgetNavigationRun } from "./ProjectNavigationMemory.ts";
import {
  memoryEnvironment,
  memoryRoute,
  redactFactInput,
  isObservedVerdict,
  resultFactsFor,
} from "./projectMemoryFacts.ts";

/**
 * A project's long-term memory. Facts are found by exact lookup on
 * state + kind + key; writing the same key again supersedes the old row.
 */
export class ProjectMemory extends Context.Service<
  ProjectMemory,
  {
    readonly recordBriefUsage: (
      threadId: ThreadId,
      brief: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly briefUsage: (
      threadId: ThreadId,
    ) => Effect.Effect<MemoryBriefUsage | null, ProjectMemoryError>;
    readonly map: (projectId: ProjectId) => Effect.Effect<ProjectMemoryMap, ProjectMemoryError>;
    /** Null when the user deleted this fact before; deleted facts never come back. */
    readonly putFact: (
      projectId: ProjectId,
      input: ProjectMemoryFactInput,
    ) => Effect.Effect<ProjectMemoryFact | null, ProjectMemoryError>;
    /**
     * Saves what an agent saw on a page of the run's site or a site the project already has
     * facts for, citing the screenshot of one of the run's scenarios.
     */
    readonly putObservedFact: (
      projectId: ProjectId,
      run: QaRun,
      input: ObservedFact,
      secrets?: ReadonlyArray<string>,
    ) => Effect.Effect<ProjectMemoryFact | null, ProjectMemoryError>;
    readonly lookupFacts: (
      projectId: ProjectId,
      lookup: ProjectMemoryFactLookup,
    ) => Effect.Effect<ReadonlyArray<ProjectMemoryFact>, ProjectMemoryError>;
    /** Every version of every fact, newest first, for the user to review. */
    readonly listFacts: (
      projectId: ProjectId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ProjectMemoryFact>, ProjectMemoryError>;
    readonly deleteFact: (
      projectId: ProjectId,
      factId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    /** Deletes a navigation screen or connection; a screen's facts go with it. */
    readonly deleteNavigationRecord: (
      projectId: ProjectId,
      id: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    /**
     * Marks earlier facts as superseded by a newer fact that says the same thing in other words.
     * Skips pairs on different states or kinds, user facts, and replacements that are not newer.
     */
    readonly supersedeFacts: (
      projectId: ProjectId,
      replacements: ReadonlyArray<{ readonly factId: string; readonly byFactId: string }>,
    ) => Effect.Effect<number, ProjectMemoryError>;
    /** Writes one `result` fact per scenario of a finished run that belongs to a project. */
    readonly recordRun: (
      run: QaRun,
      secrets?: ReadonlyArray<string>,
    ) => Effect.Effect<number, ProjectMemoryError>;
    /** Deletes every fact whose evidence points at the run. */
    readonly forgetRun: (runId: string) => Effect.Effect<void, ProjectMemoryError>;
    /** Everything remembered for a deleted project, including what was learned and tombstones. */
    readonly forgetProject: (projectId: ProjectId) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/ProjectMemory") {}

export interface ObservedFact extends Pick<
  ProjectMemoryFactInput,
  "kind" | "key" | "value" | "detail"
> {
  readonly scenarioIndex: number;
}

const FactRow = Schema.Struct({
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
  evidence: Schema.fromJsonString(Schema.Array(ProjectMemoryEvidenceRef)),
  appVersion: Schema.NullOr(Schema.String),
  author: ProjectMemoryAuthor,
  status: ProjectMemoryFactStatus,
  observedAt: Schema.String,
  supersededBy: Schema.NullOr(Schema.String),
});
type FactRow = typeof FactRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(FactRow));
const encodeEvidence = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProjectMemoryEvidenceRef)),
);
const decodeRunJson = Schema.decodeUnknownOption(Schema.fromJsonString(QaRun));
const decodeLogJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const DEFAULT_LOOKUP_LIMIT = 100;

const isProjectMemoryError = Schema.is(ProjectMemoryError);
const failure = (message: string) => (cause: unknown) =>
  isProjectMemoryError(cause) ? cause : new ProjectMemoryError({ message, cause });

const tombstoneRef = (fact: {
  readonly stateId: string;
  readonly kind: string;
  readonly key: string;
  readonly value: string;
}) => JSON.stringify([fact.stateId, fact.kind, fact.key, fact.value]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const navigation = yield* Effect.serviceOption(ProjectNavigationMemory.ProjectNavigationMemory);
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const runDir = (ref: ProjectMemoryEvidenceRef) =>
    path.join(config.stateDir, "qa-runs", qaThreadFolder(ref.threadId), ref.runId);

  const selectFacts = sql`
    SELECT
      fact_id AS "factId",
      state_id AS "stateId",
      COALESCE((SELECT json_extract(data, '$.name') FROM project_navigation_states s WHERE s.project_id = project_memory_facts.project_id AND s.state_id = project_memory_facts.state_id), state_id) AS "stateName",
      project_id AS "projectId",
      environment,
      route,
      kind,
      fact_key AS "key",
      value,
      detail,
      page_url AS "pageUrl",
      evidence_json AS "evidence",
      app_version AS "appVersion",
      author,
      status,
      observed_at AS "observedAt",
      superseded_by AS "supersededBy"
    FROM project_memory_facts
  `;

  // A ref proves something only if the run's evidence is still on disk and belongs to this
  // project. An open run has no project yet; it gets the thread's project when it finishes.
  const checkEvidence = Effect.fnUntraced(function* (
    projectId: ProjectId,
    ref: ProjectMemoryEvidenceRef,
  ) {
    const missing = new ProjectMemoryError({
      message: `Run ${ref.runId} has no ${ref.type} evidence for scenario ${ref.scenarioIndex}.`,
    });
    const text = yield* fileSystem
      .readFileString(path.join(runDir(ref), "run.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const run = decodeRunJson(text);
    if (run._tag === "None" || run.value.threadId !== ref.threadId) return yield* missing;
    if (run.value.projectId !== projectId && run.value.finishedAt !== null) return yield* missing;
    const scenario = run.value.scenarios[ref.scenarioIndex];
    const file =
      scenario === undefined
        ? null
        : ref.type === "screenshot"
          ? scenario.screenshotPath
          : ref.type === "console"
            ? scenario.consolePath
            : scenario.networkPath;
    if (file === null) return yield* missing;
    if (ref.entryIndex === undefined) {
      if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))))
        return yield* missing;
      return;
    }
    const entries = decodeLogJson(
      yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => "")),
    );
    if (entries._tag === "None" || ref.entryIndex >= entries.value.length) return yield* missing;
  });

  const toFact =
    (testing: ProjectMemoryFactLookup["testing"]) =>
    (row: FactRow): ProjectMemoryFact => ({
      ...row,
      mayBeOutdated:
        (testing?.environment !== undefined &&
          row.environment !== (memoryEnvironment(testing.environment) ?? testing.environment)) ||
        (testing?.appVersion !== undefined &&
          row.appVersion !== null &&
          row.appVersion !== testing.appVersion),
    });

  const write = Effect.fnUntraced(function* (
    projectId: ProjectId,
    raw: ProjectMemoryFactInput,
    observedAt: string,
    /** Passwords the user gave in the thread; memory keeps a placeholder instead. */
    secrets: ReadonlyArray<string> = [],
  ) {
    const hide = (text: string) => hideProvidedSecrets(text, secrets);
    let input = redactFactInput({
      ...raw,
      key: hide(raw.key),
      value: hide(raw.value),
      ...(raw.detail === undefined ? {} : { detail: hide(raw.detail) }),
    });
    // An origin as stateId is a site-wide fact, such as the tested app version, not a screen.
    const site = memoryEnvironment(input.stateId) === input.stateId ? input.stateId : null;
    const [state] =
      site !== null
        ? [{ environment: site, path: "/", name: site }]
        : yield* sql<{
            readonly environment: string;
            readonly path: string;
            readonly name: string;
          }>`
      SELECT json_extract(data, '$.environment') AS environment, json_extract(data, '$.path') AS path, json_extract(data, '$.name') AS name FROM project_navigation_states
      WHERE project_id = ${projectId} AND state_id = ${input.stateId}
    `;
    if (state === undefined) {
      return yield* new ProjectMemoryError({
        message: "Unknown screen. Call navigation_observe on this screen first.",
      });
    }
    const environment = state.environment;
    if (input.appVersion === undefined) {
      const versions = yield* sql<{ readonly appVersion: string }>`
        SELECT app_version AS "appVersion" FROM project_memory_facts
        WHERE project_id = ${projectId} AND environment = ${environment}
          AND kind = 'data' AND fact_key = 'Tested app version' AND author = 'user'
          AND app_version IS NOT NULL AND observed_at <= ${observedAt}
        ORDER BY observed_at DESC, rowid DESC LIMIT 1
      `;
      if (versions[0] !== undefined) input = { ...input, appVersion: versions[0].appVersion };
    }
    const latestVersions = yield* sql<{ readonly appVersion: string; readonly observedAt: string }>`
      SELECT app_version AS "appVersion", observed_at AS "observedAt" FROM project_memory_facts
      WHERE project_id = ${projectId} AND environment = ${environment}
        AND kind = 'data' AND fact_key = 'Tested app version' AND author = 'user' AND app_version IS NOT NULL
      ORDER BY observed_at DESC, rowid DESC LIMIT 1
    `;
    const latestVersion = latestVersions[0];
    const status =
      latestVersion !== undefined &&
      latestVersion.observedAt > observedAt &&
      input.appVersion !== latestVersion.appVersion
        ? "stale"
        : "current";
    const route = memoryRoute(state.path);
    yield* Effect.forEach(input.evidence, (ref) => checkEvidence(projectId, ref), {
      discard: true,
    });
    const evidenceJson = yield* encodeEvidence(input.evidence);
    const factId = yield* random.uuidV4();
    const identity = {
      stateId: input.stateId,
      stateName: state.name,
      environment,
      route,
      kind: input.kind,
      key: input.key,
    };

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const deleted = yield* sql`
          SELECT 1 FROM project_memory_deleted
          WHERE project_id = ${projectId}
            AND item_type = 'fact'
            AND item_ref = ${tombstoneRef({ ...identity, value: input.value })}
        `;
        if (deleted.length > 0) return null;
        if (raw.appVersion !== undefined) {
          yield* sql`
            UPDATE project_memory_facts SET status = 'stale'
            WHERE project_id = ${projectId} AND environment = ${environment}
              AND status = 'current'
              AND (app_version IS NULL OR app_version != ${input.appVersion})
          `;
        }
        const newer = yield* sql<{ readonly factId: string }>`
          SELECT fact_id AS "factId" FROM project_memory_facts
          WHERE project_id = ${projectId} AND state_id = ${input.stateId}
            AND kind = ${input.kind} AND fact_key = ${input.key}
            AND status IN ('current', 'stale') AND observed_at > ${observedAt}
          ORDER BY observed_at DESC, rowid DESC LIMIT 1
        `;
        const supersededBy = newer[0]?.factId ?? null;
        const savedStatus = supersededBy === null ? status : "superseded";
        if (supersededBy === null) {
          yield* sql`
            UPDATE project_memory_facts
            SET status = 'superseded', superseded_by = ${factId}
            WHERE project_id = ${projectId}
              AND state_id = ${input.stateId}
              AND kind = ${input.kind}
              AND fact_key = ${input.key}
              AND status IN ('current', 'stale')
          `;
        }
        yield* sql`
          INSERT INTO project_memory_facts (
            fact_id, project_id, state_id, environment, route, kind, fact_key, value, detail, page_url,
            evidence_json, app_version, author, status, observed_at, superseded_by
          ) VALUES (
            ${factId}, ${projectId}, ${input.stateId}, ${environment}, ${route}, ${input.kind}, ${input.key},
            ${input.value}, ${input.detail ?? null}, ${input.pageUrl ?? null}, ${evidenceJson},
            ${input.appVersion ?? null}, ${input.author}, ${savedStatus}, ${observedAt}, ${supersededBy}
          )
        `;
        const fact: ProjectMemoryFact = {
          factId,
          projectId,
          ...identity,
          value: input.value,
          detail: input.detail ?? null,
          pageUrl: input.pageUrl ?? null,
          evidence: input.evidence,
          appVersion: input.appVersion ?? null,
          author: input.author,
          status: savedStatus,
          observedAt,
          supersededBy,
          mayBeOutdated: false,
        };
        return fact;
      }),
    );
  });

  // When a current fact goes, the version it replaced is again the latest knowledge.
  const deleteRows = Effect.fnUntraced(function* (rows: ReadonlyArray<FactRow>) {
    for (const row of rows) {
      yield* sql`DELETE FROM project_memory_facts WHERE fact_id = ${row.factId}`;
      // Facts this one replaced under another key are the latest knowledge again.
      if (row.status === "current") {
        yield* sql`
          UPDATE project_memory_facts SET status = 'current', superseded_by = NULL
          WHERE superseded_by = ${row.factId}
            AND NOT (state_id = ${row.stateId}
              AND kind = ${row.kind} AND fact_key = ${row.key})
        `;
      }
      yield* sql`
        UPDATE project_memory_facts SET superseded_by = ${row.supersededBy}
        WHERE superseded_by = ${row.factId}
      `;
      if (row.status !== "current") continue;
      yield* sql`
        UPDATE project_memory_facts
        SET status = CASE WHEN EXISTS (
          SELECT 1 FROM project_memory_facts AS version
          WHERE version.project_id = ${row.projectId} AND version.environment = ${row.environment}
            AND version.kind = 'data'
            AND version.fact_key = 'Tested app version' AND version.author = 'user'
            AND version.status = 'current' AND version.app_version IS NOT NULL
            AND (project_memory_facts.app_version IS NULL OR version.app_version != project_memory_facts.app_version)
        ) THEN 'stale' ELSE 'current' END, superseded_by = NULL
        WHERE fact_id = (
          SELECT fact_id FROM project_memory_facts
          WHERE project_id = ${row.projectId}
            AND state_id = ${row.stateId}
            AND kind = ${row.kind}
            AND fact_key = ${row.key}
            AND status = 'superseded'
          ORDER BY observed_at DESC, rowid DESC
          LIMIT 1
        )
      `;
    }
  });

  const map = Effect.fn("ProjectMemory.map")(
    function* (projectId: ProjectId) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`${selectFacts} WHERE project_id = ${projectId} AND status = 'current'
          ORDER BY environment, route, fact_id`.pipe(Effect.flatMap(decodeRows));
          return buildProjectMap(
            rows.map(toFact(undefined)),
            yield* understanding.getItems(projectId),
            Option.isSome(navigation) ? yield* navigation.value.snapshot(projectId) : undefined,
          );
        }),
      );
    },
    Effect.mapError(failure("Could not build the project's map.")),
  );

  return ProjectMemory.of({
    recordBriefUsage: Effect.fn("ProjectMemory.recordBriefUsage")(
      function* (threadId, brief) {
        yield* sql`
          INSERT INTO project_memory_brief_usage (thread_id, characters, estimated_tokens)
          VALUES (${threadId}, ${brief.length}, ${Math.ceil(brief.length / 4)})
          ON CONFLICT (thread_id) DO UPDATE SET
            characters = excluded.characters, estimated_tokens = excluded.estimated_tokens
        `;
      },
      Effect.mapError(failure("Could not record memory brief usage.")),
    ),
    briefUsage: Effect.fn("ProjectMemory.briefUsage")(
      function* (threadId) {
        const rows = yield* sql<MemoryBriefUsage>`
          SELECT characters, estimated_tokens AS "estimatedTokens"
          FROM project_memory_brief_usage WHERE thread_id = ${threadId}
        `;
        return rows[0] ?? null;
      },
      Effect.mapError(failure("Could not read memory brief usage.")),
    ),
    map,
    putFact: Effect.fn("ProjectMemory.putFact")(
      function* (projectId, input) {
        return yield* write(projectId, input, yield* nowIso);
      },
      Effect.mapError(failure("Could not save the fact.")),
    ),

    putObservedFact: Effect.fn("ProjectMemory.putObservedFact")(function* (
      projectId,
      run,
      { scenarioIndex, ...input },
      secrets = [],
    ) {
      const scenario = run.scenarios.find((candidate) => candidate.index === scenarioIndex);
      if (scenario?.stateId === null || scenario?.stateId === undefined)
        return yield* new ProjectMemoryError({
          message: "Call navigation_observe on this screen first, then qa_evidence_record.",
        });
      return yield* write(
        projectId,
        {
          ...input,
          stateId: scenario.stateId,
          ...(scenario.pageUrl === null ? {} : { pageUrl: scenario.pageUrl }),
          evidence: [
            { threadId: run.threadId, runId: run.runId, scenarioIndex, type: "screenshot" },
          ],
          author: "agent",
        },
        yield* nowIso,
        secrets,
      ).pipe(Effect.mapError(failure("Could not save the fact.")));
    }),

    lookupFacts: Effect.fn("ProjectMemory.lookupFacts")(
      function* (projectId, lookup) {
        const environment =
          lookup.environment === undefined ? undefined : memoryEnvironment(lookup.environment);
        if (environment === null) return [];
        const rows = yield* sql`
          ${selectFacts}
          WHERE ${sql.and([
            sql`project_id = ${projectId}`,
            sql`status = ${lookup.openFailures ? "current" : (lookup.status ?? "current")}`,
            ...(environment === undefined ? [] : [sql`environment = ${environment}`]),
            ...(lookup.stateId === undefined ? [] : [sql`state_id = ${lookup.stateId}`]),
            ...(lookup.route === undefined ? [] : [sql`route = ${memoryRoute(lookup.route)}`]),
            ...(lookup.openFailures
              ? [sql`kind = 'result'`, sql`(value = 'FAIL' OR value LIKE 'FAIL %')`]
              : lookup.kind === undefined
                ? []
                : [sql`kind = ${lookup.kind}`]),
            ...(lookup.key === undefined ? [] : [sql`fact_key = ${lookup.key}`]),
            ...(lookup.runId === undefined
              ? []
              : [
                  sql`EXISTS (
                    SELECT 1 FROM json_each(evidence_json)
                    WHERE json_extract(value, '$.runId') = ${lookup.runId}
                  )`,
                ]),
          ])}
          ORDER BY observed_at DESC, rowid DESC
          LIMIT ${lookup.limit ?? DEFAULT_LOOKUP_LIMIT}
        `.pipe(Effect.flatMap(decodeRows));
        return rows.map(toFact(lookup.testing));
      },
      Effect.mapError(failure("Could not read the project's facts.")),
    ),

    listFacts: Effect.fn("ProjectMemory.listFacts")(
      function* (projectId, limit) {
        const rows = yield* sql`
          ${selectFacts}
          WHERE project_id = ${projectId}
          ORDER BY observed_at DESC, rowid DESC
          LIMIT ${limit}
        `.pipe(Effect.flatMap(decodeRows));
        return rows.map(toFact(undefined));
      },
      Effect.mapError(failure("Could not read the project's facts.")),
    ),

    deleteNavigationRecord: Effect.fn("ProjectMemory.deleteNavigationRecord")(
      function* (projectId, id) {
        if (Option.isNone(navigation))
          return yield* new ProjectMemoryError({ message: "Navigation memory is unavailable." });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              ${selectFacts}
              WHERE project_id = ${projectId} AND state_id = ${id}
              ORDER BY observed_at ASC, rowid ASC
            `.pipe(Effect.flatMap(decodeRows));
            yield* deleteRows(rows);
            yield* navigation.value.deleteRecord(projectId, id);
          }),
        );
        if (Option.isSome(navigation)) yield* navigation.value.notifyCommitted();
      },
      Effect.mapError(failure("Could not delete navigation memory.")),
    ),
    deleteFact: Effect.fn("ProjectMemory.deleteFact")(
      function* (projectId, factId) {
        const deletedAt = yield* nowIso;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              ${selectFacts}
              WHERE project_id = ${projectId} AND fact_id = ${factId}
            `.pipe(Effect.flatMap(decodeRows));
            yield* Effect.forEach(
              rows,
              (row) => sql`
                INSERT OR IGNORE INTO project_memory_deleted (
                  project_id, item_type, item_ref, deleted_at
                ) VALUES (${projectId}, 'fact', ${tombstoneRef(row)}, ${deletedAt})
              `,
              { discard: true },
            );
            yield* deleteRows(rows);
          }),
        );
      },
      Effect.mapError(failure("Could not delete the fact.")),
    ),

    supersedeFacts: Effect.fn("ProjectMemory.supersedeFacts")(
      function* (projectId, replacements) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            let replaced = 0;
            for (const { factId, byFactId } of replacements) {
              if (factId === byFactId) continue;
              const rows = yield* sql`
                ${selectFacts}
                WHERE project_id = ${projectId} AND fact_id IN (${factId}, ${byFactId})
                  AND status IN ('current', 'stale')
              `.pipe(Effect.flatMap(decodeRows));
              const old = rows.find((row) => row.factId === factId);
              const by = rows.find((row) => row.factId === byFactId);
              if (
                old === undefined ||
                by === undefined ||
                old.author === "user" ||
                old.stateId !== by.stateId ||
                old.kind !== by.kind ||
                old.observedAt > by.observedAt ||
                (by.kind === "result" && !isObservedVerdict(by.value))
              )
                continue;
              yield* sql`
                UPDATE project_memory_facts SET status = 'superseded', superseded_by = ${byFactId}
                WHERE fact_id = ${factId}
              `;
              replaced += 1;
            }
            return replaced;
          }),
        );
      },
      Effect.mapError(failure("Could not replace the facts.")),
    ),

    recordRun: Effect.fn("ProjectMemory.recordRun")(
      function* (run, secrets = []) {
        const projectId = run.projectId;
        if (projectId === null || run.finishedAt === null) return 0;
        const recorded = yield* sql<{ readonly scenarioIndex: number }>`
          SELECT DISTINCT json_extract(evidence.value, '$.scenarioIndex') AS "scenarioIndex"
          FROM project_memory_facts AS fact, json_each(fact.evidence_json) AS evidence
          WHERE fact.project_id = ${projectId} AND fact.kind = 'result'
            AND json_extract(evidence.value, '$.runId') = ${run.runId}
        `;
        const recordedScenarios = new Set(recorded.map((row) => row.scenarioIndex));
        let written = 0;
        for (const { scenarioIndex, corrects, fact } of resultFactsFor(run)) {
          if (recordedScenarios.has(scenarioIndex)) continue;
          if (corrects.length > 0) {
            const corrected = yield* sql`
              ${selectFacts}
              WHERE project_id = ${projectId} AND kind = 'result' AND author = 'server'
                AND EXISTS (
                  SELECT 1 FROM json_each(evidence_json)
                  WHERE json_extract(value, '$.runId') = ${run.runId}
                    AND json_extract(value, '$.scenarioIndex') IN ${sql.in(corrects)}
                )
            `.pipe(Effect.flatMap(decodeRows));
            yield* sql.withTransaction(deleteRows(corrected));
          }
          if (fact === null) continue;
          if ((yield* write(projectId, fact.input, fact.observedAt, secrets)) !== null) {
            written += 1;
          }
        }
        return written;
      },
      Effect.mapError(failure("Could not save the run's results to project memory.")),
    ),

    forgetRun: Effect.fn("ProjectMemory.forgetRun")(
      function* (runId) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              ${selectFacts}
              WHERE EXISTS (
                SELECT 1 FROM json_each(evidence_json)
                WHERE json_extract(value, '$.runId') = ${runId}
              )
              ORDER BY observed_at ASC, rowid ASC
            `.pipe(Effect.flatMap(decodeRows));
            yield* deleteRows(rows);
            yield* forgetNavigationRun(sql, runId);
          }),
        );
        if (Option.isSome(navigation)) yield* navigation.value.notifyCommitted();
      },
      Effect.mapError(failure("Could not delete the run's facts.")),
    ),

    forgetProject: Effect.fn("ProjectMemory.forgetProject")(
      function* (projectId) {
        const items = sql`
          SELECT item_id FROM project_memory_understanding WHERE project_id = ${projectId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM project_memory_links WHERE item_id IN (${items})`;
            yield* sql`
              DELETE FROM project_memory_dependencies
              WHERE item_id IN (${items}) OR depends_on_item_id IN (${items})
            `;
            yield* sql`
              DELETE FROM project_memory_understanding_versions WHERE item_id IN (${items})
            `;
            yield* sql`
              DELETE FROM project_memory_understanding_search WHERE project_id = ${projectId}
            `;
            yield* sql`DELETE FROM project_memory_understanding WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_memory_facts WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_memory_deleted WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_memory_extractions WHERE project_id = ${projectId}`;
            yield* bumpNavigationRevision(sql, projectId, [], true);
            yield* sql`DELETE FROM project_navigation_search WHERE rowid IN (SELECT rowid FROM project_navigation_states WHERE project_id = ${projectId})`;
            yield* sql`DELETE FROM project_navigation_terms WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_cluster_connections WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_clusters WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_connections WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_feedback WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_observations WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_navigation_states WHERE project_id = ${projectId}`;
          }),
        );
        if (Option.isSome(navigation)) yield* navigation.value.notifyCommitted();
      },
      Effect.mapError(failure("Could not delete the project's memory.")),
    ),
  });
});

export const layer = Layer.effect(ProjectMemory, make);
