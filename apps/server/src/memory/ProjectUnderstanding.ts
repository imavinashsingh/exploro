import {
  ProjectId,
  ProjectMemoryAuthor,
  ProjectMemoryError,
  ProjectUnderstandingKind,
  ProjectUnderstandingStatus,
  type ProjectUnderstandingItem,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as MemoryEmbedder from "./MemoryEmbedder.ts";

export interface UnderstandingWrite {
  /** Names this write so other writes in the batch can depend on it. */
  readonly ref: string;
  /** The item to revise, or null for a new one. */
  readonly itemId: string | null;
  readonly kind: ProjectUnderstandingKind;
  readonly statement: string;
  readonly citedFactIds: ReadonlyArray<string>;
  /** Refs from this batch or ids of existing items. */
  readonly dependsOn: ReadonlyArray<string>;
  readonly author: ProjectMemoryAuthor;
  /** Only the user may confirm. */
  readonly confirm?: boolean;
}

export interface UnderstandingVersion {
  readonly version: number;
  readonly kind: ProjectUnderstandingKind;
  readonly statement: string;
  readonly status: ProjectUnderstandingStatus;
  readonly author: ProjectMemoryAuthor;
  readonly citedFactIds: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  readonly changedAt: string;
}

export interface RecalledUnderstanding {
  readonly item: ProjectUnderstandingItem;
  /** "dependency" when the item came in because a matched item depends on it. */
  readonly via: "match" | "dependency";
}

export interface UnderstandingRecall {
  readonly mode: "semantic" | "text";
  readonly items: ReadonlyArray<RecalledUnderstanding>;
}

/** What the agent has learned about how a project's app works, found by meaning. */
export class ProjectUnderstanding extends Context.Service<
  ProjectUnderstanding,
  {
    /**
     * Agent items become verified only when every cited fact is current, backed by evidence and
     * from `environment`; otherwise they are hypotheses. Items the user confirmed are never
     * revised by an agent.
     */
    readonly saveItems: (
      projectId: ProjectId,
      writes: ReadonlyArray<UnderstandingWrite>,
      context: { readonly environment: string | null },
    ) => Effect.Effect<ReadonlyArray<ProjectUnderstandingItem>, ProjectMemoryError>;
    readonly getItems: (
      projectId: ProjectId,
      itemIds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ProjectUnderstandingItem>, ProjectMemoryError>;
    readonly history: (
      projectId: ProjectId,
      itemId: string,
    ) => Effect.Effect<ReadonlyArray<UnderstandingVersion>, ProjectMemoryError>;
    readonly recall: (
      projectId: ProjectId,
      query: string,
      options?: { readonly limit?: number },
    ) => Effect.Effect<UnderstandingRecall, ProjectMemoryError>;
  }
>()("t3/memory/ProjectUnderstanding") {}

const StringList = Schema.fromJsonString(Schema.Array(Schema.String));
const ItemRow = Schema.Struct({
  itemId: Schema.String,
  projectId: ProjectId,
  kind: ProjectUnderstandingKind,
  statement: Schema.String,
  status: ProjectUnderstandingStatus,
  author: ProjectMemoryAuthor,
  version: Schema.Int,
  citedFactIds: StringList,
  dependsOn: StringList,
  staleCitations: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const encodeStringList = Schema.encodeEffect(StringList);
const decodeItemRows = Schema.decodeUnknownEffect(Schema.Array(ItemRow));
const VersionRow = Schema.Struct({
  version: Schema.Int,
  kind: ProjectUnderstandingKind,
  statement: Schema.String,
  status: ProjectUnderstandingStatus,
  author: ProjectMemoryAuthor,
  citedFactIds: StringList,
  dependsOn: StringList,
  changedAt: Schema.String,
});
const decodeVersionRows = Schema.decodeUnknownEffect(Schema.Array(VersionRow));
const EmbeddingRow = Schema.Struct({ itemId: Schema.String, embedding: Schema.Uint8Array });
const decodeEmbeddingRows = Schema.decodeUnknownEffect(Schema.Array(EmbeddingRow));

const isProjectMemoryError = Schema.is(ProjectMemoryError);
const failure = (message: string) => (cause: unknown) =>
  isProjectMemoryError(cause) ? cause : new ProjectMemoryError({ message, cause });

const RRF_K = 60;
// Below this, a statement shares little meaning with the query; MiniLM puts unrelated text near 0.1.
const MIN_SIMILARITY = 0.3;
const STOP_WORDS = new Set(
  "a an and are as at be by can do for from has have in is it of on or so that the then this to was when with you your test tests testing check".split(
    " ",
  ),
);
const CANDIDATES = 50;
const MAX_STATEMENT_CHARS = 300;

/** FTS5 query matching any word of `text`, so punctuation in a goal cannot break the syntax. */
function textSearchQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 24);
  return words.length === 0 ? null : words.map((word) => `"${word}"`).join(" OR ");
}

/** Reciprocal rank fusion: each list adds 1 / (k + rank) for the ids it ranks. */
function fuseRankings(rankings: ReadonlyArray<ReadonlyArray<string>>): Array<string> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
}

const cosine = (left: Float32Array, right: Float32Array) => {
  let dot = 0;
  for (let index = 0; index < left.length && index < right.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
};

const toBlob = (vector: Float32Array) =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
const fromBlob = (blob: Uint8Array) =>
  new Float32Array(blob.slice().buffer, 0, Math.floor(blob.byteLength / 4));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const embedder = yield* MemoryEmbedder.MemoryEmbedder;

  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  const loadItems = (projectId: ProjectId, itemIds?: ReadonlyArray<string>) =>
    sql`
      SELECT
        item.item_id AS "itemId",
        item.project_id AS "projectId",
        item.kind,
        item.statement,
        item.status,
        item.author,
        item.version,
        (
          SELECT json_group_array(link.fact_id) FROM project_memory_links AS link
          WHERE link.item_id = item.item_id
        ) AS "citedFactIds",
        (
          SELECT json_group_array(dependency.depends_on_item_id)
          FROM project_memory_dependencies AS dependency
          WHERE dependency.item_id = item.item_id
        ) AS "dependsOn",
        (
          SELECT COUNT(*) FROM project_memory_links AS link
          LEFT JOIN project_memory_facts AS fact
            ON fact.fact_id = link.fact_id AND fact.status = 'current'
          WHERE link.item_id = item.item_id AND fact.fact_id IS NULL
        ) AS "staleCitations",
        item.created_at AS "createdAt",
        item.updated_at AS "updatedAt"
      FROM project_memory_understanding AS item
      WHERE ${sql.and([
        sql`item.project_id = ${projectId}`,
        ...(itemIds === undefined ? [] : [sql.in("item.item_id", itemIds)]),
      ])}
      ORDER BY item.updated_at DESC
    `.pipe(
      Effect.flatMap(decodeItemRows),
      // A verified item whose facts were since deleted or superseded is a hypothesis again.
      Effect.map((rows) =>
        rows.map(({ staleCitations, ...item }): ProjectUnderstandingItem => ({
          ...item,
          status: item.status === "verified" && staleCitations > 0 ? "hypothesis" : item.status,
        })),
      ),
    );

  // The user's own words carry no evidence, so they neither verify an item nor block it.
  const verifiable = Effect.fnUntraced(function* (
    projectId: ProjectId,
    factIds: ReadonlyArray<string>,
    environment: string | null,
  ) {
    if (factIds.length === 0 || environment === null) return false;
    const rows = yield* sql<{
      readonly author: string;
      readonly status: string;
      readonly environment: string;
      readonly evidence: number;
    }>`
      SELECT author, status, environment, json_array_length(evidence_json) AS evidence
      FROM project_memory_facts
      WHERE ${sql.and([sql`project_id = ${projectId}`, sql.in("fact_id", factIds)])}
    `;
    const observed = rows.filter((row) => row.author !== "user");
    return (
      rows.length === new Set(factIds).size &&
      rows.every((row) => row.status === "current") &&
      observed.length > 0 &&
      observed.every((row) => row.environment === environment && row.evidence > 0)
    );
  });

  const saveItems: ProjectUnderstanding["Service"]["saveItems"] = Effect.fn(
    "ProjectUnderstanding.saveItems",
  )(
    function* (projectId, writes, context) {
      const changedAt = yield* nowIso;
      const existing = new Map(
        (yield* loadItems(
          projectId,
          writes.flatMap((write) => (write.itemId === null ? [] : [write.itemId])),
        )).map((item) => [item.itemId, item]),
      );
      const ids = new Map<string, string>();
      const accepted: Array<UnderstandingWrite & { readonly itemId: string }> = [];
      for (const write of writes) {
        if (write.confirm === true && write.author !== "user") {
          return yield* new ProjectMemoryError({ message: "Only the user can confirm an item." });
        }
        const current = write.itemId === null ? undefined : existing.get(write.itemId);
        if (write.itemId !== null && current === undefined) continue;
        if (current?.status === "confirmed" && write.author !== "user") continue;
        const itemId = write.itemId ?? (yield* random.uuidV4());
        ids.set(write.ref, itemId);
        accepted.push({ ...write, itemId });
      }
      const known = new Set((yield* loadItems(projectId)).map((item) => item.itemId));
      const resolved = yield* Effect.forEach(accepted, (write) =>
        Effect.gen(function* () {
          const statement = write.statement.trim().slice(0, MAX_STATEMENT_CHARS);
          const citedFactIds = [...new Set(write.citedFactIds)];
          const dependsOn = [
            ...new Set(
              write.dependsOn
                .map((ref) => ids.get(ref) ?? (known.has(ref) ? ref : null))
                .filter((id): id is string => id !== null && id !== write.itemId),
            ),
          ];
          const status: ProjectUnderstandingStatus =
            write.author === "user" && write.confirm === true
              ? "confirmed"
              : (yield* verifiable(projectId, citedFactIds, context.environment))
                ? "verified"
                : "hypothesis";
          return { ...write, statement, citedFactIds, dependsOn, status };
        }),
      );
      const changed = resolved.filter((write) => {
        const current = existing.get(write.itemId);
        return (
          write.statement.length > 0 &&
          (current === undefined ||
            current.kind !== write.kind ||
            current.statement !== write.statement ||
            current.status !== write.status ||
            JSON.stringify(current.citedFactIds.toSorted()) !==
              JSON.stringify(write.citedFactIds.toSorted()) ||
            JSON.stringify(current.dependsOn.toSorted()) !==
              JSON.stringify(write.dependsOn.toSorted()))
        );
      });
      const vectors = yield* embedder.embed(changed.map((write) => write.statement));
      const model = vectors === null ? null : (yield* embedder.status).model;

      yield* sql.withTransaction(
        Effect.forEach(
          changed,
          (write, index) =>
            Effect.gen(function* () {
              const vector = vectors?.[index];
              const embedding = vector === undefined ? null : toBlob(vector);
              const version = (existing.get(write.itemId)?.version ?? 0) + 1;
              yield* sql`
                INSERT INTO project_memory_understanding (
                  item_id, project_id, kind, statement, status, author, embedding,
                  embedding_model, created_at, updated_at, version
                ) VALUES (
                  ${write.itemId}, ${projectId}, ${write.kind}, ${write.statement},
                  ${write.status}, ${write.author}, ${embedding}, ${model}, ${changedAt},
                  ${changedAt}, ${version}
                )
                ON CONFLICT (item_id) DO UPDATE SET
                  kind = excluded.kind,
                  statement = excluded.statement,
                  status = excluded.status,
                  author = excluded.author,
                  embedding = excluded.embedding,
                  embedding_model = excluded.embedding_model,
                  updated_at = excluded.updated_at,
                  version = excluded.version
              `;
              yield* sql`
                INSERT INTO project_memory_understanding_versions (
                  item_id, version, kind, statement, status, author, cited_fact_ids_json,
                  depends_on_json, changed_at
                ) VALUES (
                  ${write.itemId}, ${version}, ${write.kind}, ${write.statement}, ${write.status},
                  ${write.author}, ${yield* encodeStringList(write.citedFactIds)},
                  ${yield* encodeStringList(write.dependsOn)}, ${changedAt}
                )
              `;
              yield* sql`DELETE FROM project_memory_links WHERE item_id = ${write.itemId}`;
              for (const factId of write.citedFactIds) {
                yield* sql`
                  INSERT INTO project_memory_links (item_id, fact_id)
                  VALUES (${write.itemId}, ${factId})
                `;
              }
              yield* sql`DELETE FROM project_memory_dependencies WHERE item_id = ${write.itemId}`;
              for (const dependency of write.dependsOn) {
                yield* sql`
                  INSERT INTO project_memory_dependencies (item_id, depends_on_item_id)
                  VALUES (${write.itemId}, ${dependency})
                `;
              }
              yield* sql`
                DELETE FROM project_memory_understanding_search WHERE item_id = ${write.itemId}
              `;
              yield* sql`
                INSERT INTO project_memory_understanding_search (statement, item_id, project_id)
                VALUES (${write.statement}, ${write.itemId}, ${projectId})
              `;
            }),
          { discard: true },
        ),
      );
      if (changed.length === 0) return [];
      const saved = new Map(
        (yield* loadItems(
          projectId,
          changed.map((write) => write.itemId),
        )).map((item) => [item.itemId, item]),
      );
      return changed.flatMap((write) => saved.get(write.itemId) ?? []);
    },
    Effect.mapError(failure("Could not save the project's understanding.")),
  );

  const textMatches = Effect.fnUntraced(function* (projectId: ProjectId, query: string) {
    const match = textSearchQuery(query);
    if (match === null) return [];
    const rows = yield* sql<{ readonly itemId: string }>`
      SELECT item_id AS "itemId" FROM project_memory_understanding_search
      WHERE project_memory_understanding_search MATCH ${match} AND project_id = ${projectId}
      ORDER BY bm25(project_memory_understanding_search)
      LIMIT ${CANDIDATES}
    `;
    return rows.map((row) => row.itemId);
  });

  const semanticMatches = Effect.fnUntraced(function* (projectId: ProjectId, query: string) {
    const vectors = yield* embedder.embed([query]);
    const target = vectors?.[0];
    if (target === undefined) return null;
    const { model } = yield* embedder.status;
    const rows = yield* sql`
      SELECT item_id AS "itemId", embedding FROM project_memory_understanding
      WHERE project_id = ${projectId} AND embedding IS NOT NULL AND embedding_model IS ${model}
    `.pipe(Effect.flatMap(decodeEmbeddingRows));
    return rows
      .map((row) => ({ itemId: row.itemId, score: cosine(target, fromBlob(row.embedding)) }))
      .filter((row) => row.score >= MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score)
      .slice(0, CANDIDATES)
      .map((row) => row.itemId);
  });

  return ProjectUnderstanding.of({
    saveItems,
    getItems: Effect.fn("ProjectUnderstanding.getItems")(
      function* (projectId, itemIds) {
        return yield* loadItems(projectId, itemIds);
      },
      Effect.mapError(failure("Could not read the project's understanding.")),
    ),
    history: Effect.fn("ProjectUnderstanding.history")(
      function* (projectId, itemId) {
        return yield* sql`
          SELECT
            version.version,
            version.kind,
            version.statement,
            version.status,
            version.author,
            version.cited_fact_ids_json AS "citedFactIds",
            version.depends_on_json AS "dependsOn",
            version.changed_at AS "changedAt"
          FROM project_memory_understanding_versions AS version
          JOIN project_memory_understanding AS item ON item.item_id = version.item_id
          WHERE item.project_id = ${projectId} AND version.item_id = ${itemId}
          ORDER BY version.version
        `.pipe(Effect.flatMap(decodeVersionRows));
      },
      Effect.mapError(failure("Could not read the item's history.")),
    ),
    recall: Effect.fn("ProjectUnderstanding.recall")(
      function* (projectId, query, options) {
        const limit = options?.limit ?? 8;
        const semantic = yield* semanticMatches(projectId, query);
        const text = yield* textMatches(projectId, query);
        const matched = fuseRankings(semantic === null ? [text] : [semantic, text]).slice(0, limit);
        const all = new Map((yield* loadItems(projectId)).map((item) => [item.itemId, item]));
        const recalled = new Map<string, RecalledUnderstanding>();
        for (const itemId of matched) {
          const item = all.get(itemId);
          if (item !== undefined) recalled.set(itemId, { item, via: "match" });
        }
        // Follow `depends on` links so a workflow arrives with what it needs.
        const queue = [...recalled.values()].flatMap(({ item }) => item.dependsOn);
        while (queue.length > 0 && recalled.size < limit * 2) {
          const itemId = queue.shift()!;
          const item = all.get(itemId);
          if (item === undefined || recalled.has(itemId)) continue;
          recalled.set(itemId, { item, via: "dependency" });
          queue.push(...item.dependsOn);
        }
        return {
          mode: semantic === null ? "text" : "semantic",
          items: [...recalled.values()],
        } satisfies UnderstandingRecall;
      },
      Effect.mapError(failure("Could not recall the project's understanding.")),
    ),
  });
});

export const layer = Layer.effect(ProjectUnderstanding, make);
