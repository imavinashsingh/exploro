import {
  ProjectMemoryError,
  ProjectMemoryEvidenceRef,
  ProjectMemoryAuthor,
  ProjectMemoryFactKind,
  ProjectMemoryFactStatus,
  ProjectId,
  QaRun,
  type ProjectMemoryMap,
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
import {
  memoryEnvironment,
  memoryRoute,
  projectOrigins,
  redactFactInput,
  resultFactsFor,
} from "./projectMemoryFacts.ts";

/**
 * A project's long-term memory. Facts are found by exact lookup on
 * environment + route + kind + key; writing the same key again supersedes the old row.
 */
export class ProjectMemory extends Context.Service<
  ProjectMemory,
  {
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
    readonly deleteFact: (
      projectId: ProjectId,
      factId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    /** Writes one `result` fact per scenario of a finished run that belongs to a project. */
    readonly recordRun: (
      run: QaRun,
      secrets?: ReadonlyArray<string>,
    ) => Effect.Effect<number, ProjectMemoryError>;
    /** Deletes every fact whose evidence points at the run. */
    readonly forgetRun: (runId: string) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/ProjectMemory") {}

export interface ObservedFact extends Pick<
  ProjectMemoryFactInput,
  "kind" | "key" | "value" | "detail"
> {
  readonly pageUrl: string;
  readonly scenarioIndex: number;
}

const FactRow = Schema.Struct({
  factId: Schema.String,
  projectId: ProjectId,
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
  readonly environment: string;
  readonly route: string;
  readonly kind: string;
  readonly key: string;
  readonly value: string;
}) => JSON.stringify([fact.environment, fact.route, fact.kind, fact.key, fact.value]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
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
    const input = redactFactInput({
      ...raw,
      key: hide(raw.key),
      value: hide(raw.value),
      ...(raw.detail === undefined ? {} : { detail: hide(raw.detail) }),
    });
    const environment = memoryEnvironment(input.environment);
    if (environment === null) {
      return yield* new ProjectMemoryError({
        message: "A fact's environment must be an http(s) URL or origin.",
      });
    }
    const route = memoryRoute(input.route);
    yield* Effect.forEach(input.evidence, (ref) => checkEvidence(projectId, ref), {
      discard: true,
    });
    const evidenceJson = yield* encodeEvidence(input.evidence);
    const factId = yield* random.uuidV4();
    const identity = { environment, route, kind: input.kind, key: input.key };

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const deleted = yield* sql`
          SELECT 1 FROM project_memory_deleted
          WHERE project_id = ${projectId}
            AND item_type = 'fact'
            AND item_ref = ${tombstoneRef({ ...identity, value: input.value })}
        `;
        if (deleted.length > 0) return null;
        yield* sql`
          UPDATE project_memory_facts
          SET status = 'superseded', superseded_by = ${factId}
          WHERE project_id = ${projectId}
            AND environment = ${environment}
            AND route = ${route}
            AND kind = ${input.kind}
            AND fact_key = ${input.key}
            AND status = 'current'
        `;
        yield* sql`
          INSERT INTO project_memory_facts (
            fact_id, project_id, environment, route, kind, fact_key, value, detail, page_url,
            evidence_json, app_version, author, status, observed_at, superseded_by
          ) VALUES (
            ${factId}, ${projectId}, ${environment}, ${route}, ${input.kind}, ${input.key},
            ${input.value}, ${input.detail ?? null}, ${input.pageUrl ?? null}, ${evidenceJson},
            ${input.appVersion ?? null}, ${input.author}, 'current', ${observedAt}, NULL
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
          status: "current",
          observedAt,
          supersededBy: null,
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
      yield* sql`
        UPDATE project_memory_facts SET superseded_by = ${row.supersededBy}
        WHERE superseded_by = ${row.factId}
      `;
      if (row.status !== "current") continue;
      yield* sql`
        UPDATE project_memory_facts
        SET status = 'current', superseded_by = NULL
        WHERE fact_id = (
          SELECT fact_id FROM project_memory_facts
          WHERE project_id = ${row.projectId}
            AND environment = ${row.environment}
            AND route = ${row.route}
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
          );
        }),
      );
    },
    Effect.mapError(failure("Could not build the project's map.")),
  );

  return ProjectMemory.of({
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
      { pageUrl, scenarioIndex, ...input },
      secrets = [],
    ) {
      const environment = memoryEnvironment(pageUrl);
      const known = yield* sql<{ readonly environment: string }>`
          SELECT DISTINCT environment FROM project_memory_facts
          WHERE project_id = ${projectId} AND status = 'current'
        `.pipe(Effect.mapError(failure("Could not read the project's sites.")));
      const origins = projectOrigins(
        run,
        known.map((row) => row.environment),
      );
      if (environment === null || !origins.has(environment))
        return yield* new ProjectMemoryError({
          message: `${pageUrl} is not on a site this project tests (${[...origins].join(", ") || "none yet"}).`,
        });
      return yield* write(
        projectId,
        {
          ...input,
          environment,
          route: pageUrl,
          pageUrl,
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

    recordRun: Effect.fn("ProjectMemory.recordRun")(
      function* (run, secrets = []) {
        const projectId = run.projectId;
        if (projectId === null || run.finishedAt === null) return 0;
        let written = 0;
        for (const { input, observedAt } of resultFactsFor(run)) {
          if ((yield* write(projectId, input, observedAt, secrets)) !== null) written += 1;
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
          }),
        );
      },
      Effect.mapError(failure("Could not delete the run's facts.")),
    ),
  });
});

export const layer = Layer.effect(ProjectMemory, make);
