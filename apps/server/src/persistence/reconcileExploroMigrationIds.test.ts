import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectMemory from "./Migrations/099_ProjectMemory.ts";
import ProjectUnderstanding from "./Migrations/100_ProjectUnderstanding.ts";
import { reconciledExploroHistory } from "./reconcileExploroMigrationIds.ts";

// What an Exploro build from before the upstream sync left: its migrations at 96 and 97.
const seedOldExploro = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 95 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "96_ProjectMemory": ProjectMemory,
      "97_ProjectUnderstanding": ProjectUnderstanding,
    }),
  });
  yield* sql`
    INSERT INTO project_memory_understanding
      (item_id, project_id, kind, statement, status, author, created_at, updated_at)
    VALUES ('item-1', 'project-1', 'flow', 'Checkout needs a login', 'current', 'agent', '2026-11-01', '2026-11-01')
  `;
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("Exploro migration id upgrade", () => {
  it.effect("runs upstream 96-98 and keeps Exploro's memory data at its new ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOldExploro;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 101 }), [
        [96, "RepairStaleTitleRegeneration"],
        [97, "IssueTrackerBindings"],
        [98, "ActiveShellIndexIndexes"],
        [101, "MemoryBriefUsage"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT item_id, version FROM project_memory_understanding`,
        [{ item_id: "item-1", version: 1 }],
      );
      // 103 resets pre-release memory on purpose, so the data check stops before it.
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 101),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses an unexpected history after Exploro's ids without changing it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOldExploro;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (98, 'UnknownFork')`;
      const before = yield* history;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it("predicts the history startup leaves, for the service preflight", () => {
    const base = migrationManifest.filter(([id]) => id < 96).map(([id, name]) => ({ id, name }));
    const upgraded = reconciledExploroHistory([
      ...base,
      { id: 96, name: "ProjectMemory" },
      { id: 97, name: "ProjectUnderstanding" },
      { id: 98, name: "MemoryBriefUsage" },
    ]);
    // Startup reconciles up to Exploro's moved ids; later migrations then run normally.
    assert.deepStrictEqual(
      upgraded?.map(({ id, name }) => [id, name] as const),
      migrationManifest.filter(([id]) => id <= 101),
    );
    assert.strictEqual(
      reconciledExploroHistory([...base, { id: 96, name: "ProjectMemory" }, { id: 97, name: "X" }]),
      null,
    );
  });
});
