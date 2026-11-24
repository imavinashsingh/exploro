import { qaSiteOrigin, type ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";

const aliases: Readonly<Record<string, string>> = {
  development: "dev",
  production: "prod",
  stage: "staging",
  testing: "test",
};

export const memoryEnvironmentOrigin = (value: string): string | null => qaSiteOrigin(value.trim());

export function normalizeMemoryEnvironment(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return (
    memoryEnvironmentOrigin(trimmed) ?? aliases[trimmed.toLowerCase()] ?? trimmed.toLowerCase()
  );
}

function label(value: string): string {
  const origin = qaSiteOrigin(value);
  const prefix = origin === null ? value : new URL(origin).hostname.split(/[.-]/u)[0]!;
  return aliases[prefix] ?? prefix;
}

export function memoryEnvironmentMatches(
  requested: string | null | undefined,
  saved: string | null | undefined,
): boolean {
  const scope = normalizeMemoryEnvironment(requested);
  const environment = normalizeMemoryEnvironment(saved);
  if (scope === null || environment === null || scope === environment) return true;
  if (qaSiteOrigin(scope) !== null && qaSiteOrigin(environment) !== null) return false;
  return label(scope) === label(environment);
}

// Resolve against stored scopes too, so existing origin-based facts need no destructive migration.
export const makeMemoryEnvironmentResolver = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  return Effect.fn("MemoryEnvironment.resolve")(function* (
    projectId: ProjectId,
    value?: string | null,
  ) {
    const appliedEnvironment = normalizeMemoryEnvironment(value);
    if (appliedEnvironment === null) return { appliedEnvironment, environments: [] as string[] };
    const sites = Option.isSome(settings)
      ? resolveProjectSettings(yield* settings.value.getSettings, projectId).settings.qaSiteOrigins
      : [];
    const rows = yield* sql<{ environment: string | null }>`
      SELECT environment FROM memory_docs WHERE project_id = ${projectId}
      UNION SELECT environment FROM project_memory_facts WHERE project_id = ${projectId}
      UNION SELECT environment FROM project_navigation_states WHERE project_id = ${projectId}`;
    const candidates = [
      appliedEnvironment,
      ...Object.keys(aliases),
      ...Object.values(aliases),
      ...sites,
      ...rows.flatMap((row) => (row.environment === null ? [] : [row.environment])),
    ];
    return {
      appliedEnvironment,
      environments: [
        ...new Set(
          candidates.filter((candidate) => memoryEnvironmentMatches(appliedEnvironment, candidate)),
        ),
      ],
    };
  });
});
