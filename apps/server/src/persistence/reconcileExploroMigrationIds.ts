import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import RepairStaleTitleRegeneration from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import IssueTrackerBindings from "./Migrations/097_IssueTrackerBindings.ts";
import ActiveShellIndexIndexes from "./Migrations/098_ActiveShellIndexIndexes.ts";

type MigrationRow = { readonly id: number; readonly name: string };

// Exploro builds before the upstream sync recorded its migrations at ids upstream later took.
const EXPLORO_MOVED = [
  { from: 96, to: 99, name: "ProjectMemory" },
  { from: 97, to: 100, name: "ProjectUnderstanding" },
  { from: 98, to: 101, name: "MemoryBriefUsage" },
] as const;
const UPSTREAM = [
  { id: 96, name: "RepairStaleTitleRegeneration", migration: RepairStaleTitleRegeneration },
  { id: 97, name: "IssueTrackerBindings", migration: IssueTrackerBindings },
  { id: 98, name: "ActiveShellIndexIndexes", migration: ActiveShellIndexIndexes },
] as const;

function movedCount(history: ReadonlyArray<MigrationRow>): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 96).toSorted((a, b) => a.id - b.id);
  if (!later.some((row) => row.id === 96 && row.name === EXPLORO_MOVED[0].name)) return undefined;
  const valid =
    later.length <= EXPLORO_MOVED.length &&
    later.every(
      (row, index) =>
        row.id === EXPLORO_MOVED[index]!.from && row.name === EXPLORO_MOVED[index]!.name,
    );
  return valid ? later.length : "invalid";
}

/** The history as startup's Exploro id reconciliation leaves it, or null when startup rejects it. */
export function reconciledExploroHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const count = movedCount(history);
  if (count === undefined) return history;
  if (count === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 96),
    ...UPSTREAM.map(({ id, name }) => ({ id, name })),
    ...EXPLORO_MOVED.slice(0, count).map(({ to, name }) => ({ id: to, name })),
  ];
}

export const reconcileExploroMigrationIds = Effect.fn("reconcileExploroMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 96
      `;
      const count = movedCount(history.map((row) => ({ id: row.migration_id, name: row.name })));
      if (count === undefined) return [];
      if (count === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot move Exploro migrations past unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      for (const { id, name, migration } of UPSTREAM) {
        yield* migration;
        executed.push([id, name]);
      }
      for (const { from, to, name } of EXPLORO_MOVED.slice(0, count)) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${to} WHERE migration_id = ${from} AND name = ${name}`;
      }
      for (const { id, name } of UPSTREAM) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      return executed;
    }),
  );
});
