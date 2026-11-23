import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { parse, stringify } from "yaml";
import { MemoryDoc, ProjectMemoryError, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { memoryEnvironment, memoryRoute } from "./projectMemoryFacts.ts";

const decodeDoc = Schema.decodeUnknownSync(MemoryDoc);
const validateDoc = Schema.decodeSync(MemoryDoc);
const decodeDocEffect = Schema.decodeEffect(MemoryDoc);
const isMemoryError = Schema.is(ProjectMemoryError);
const encodeStrings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

type MemoryDocInput = Omit<MemoryDoc, "docId" | "status">;
type SearchOptions = { readonly environment?: string; readonly limit?: number };

export class MarkdownMemoryStore extends Context.Service<
  MarkdownMemoryStore,
  {
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void, ProjectMemoryError>;
    readonly listDocs: (
      projectId: ProjectId,
      environment?: string,
    ) => Effect.Effect<ReadonlyArray<MemoryDoc>, ProjectMemoryError>;
    readonly saveUserDoc: (input: MemoryDocInput) => Effect.Effect<MemoryDoc, ProjectMemoryError>;
    readonly saveDraftDoc: (input: MemoryDocInput) => Effect.Effect<MemoryDoc, ProjectMemoryError>;
    readonly searchDocs: (
      projectId: ProjectId,
      query: string,
      options?: SearchOptions,
    ) => Effect.Effect<ReadonlyArray<MemoryDoc>, ProjectMemoryError>;
    readonly matchDocsByRoutes: (
      projectId: ProjectId,
      routes: ReadonlyArray<string>,
      environment?: string,
    ) => Effect.Effect<ReadonlyArray<MemoryDoc>, ProjectMemoryError>;
    readonly migrateLegacyUnderstandingIfEmpty: (
      projectId: ProjectId,
    ) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/MarkdownMemoryStore") {}

export function validateMemorySlug(slug: string): string {
  if (!/^[a-z0-9-]+$/u.test(slug)) throw new Error("Invalid memory slug");
  return slug;
}

export function parseMemoryMarkdown(
  markdown: string,
  projectId: ProjectId,
  kind: MemoryDoc["kind"],
  slug: string,
): MemoryDoc {
  validateMemorySlug(slug);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (match === null) throw new Error("Memory document requires YAML frontmatter");
  const metadata: unknown = parse(match[1]!, { maxAliasCount: 0, uniqueKeys: true });
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid memory frontmatter");
  const doc = decodeDoc({
    summary: "",
    routes: [],
    keywords: [],
    ...metadata,
    docId: `${projectId}:${kind}:${slug}`,
    projectId,
    kind,
    slug,
    body: match[2]!,
  });
  return {
    ...doc,
    ...(doc.environment === undefined
      ? {}
      : { environment: memoryEnvironment(doc.environment) ?? doc.environment }),
  };
}

export function serializeMemoryMarkdown(doc: MemoryDoc): string {
  validateDoc(doc);
  const { docId: _docId, projectId: _projectId, body, ...metadata } = doc;
  return `---\n${stringify(metadata).trimEnd()}\n---\n${body}`;
}

// Quoting individual tokenizer words makes every operator and URL ordinary search text.
function sanitizeMemoryQuery(query: string): string {
  return [...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])]
    .slice(0, 64)
    .map((word) => `"${word}"`)
    .join(" OR ");
}

function memoryRouteMatches(saved: string, requested: string): boolean {
  const prefix = memoryRoute(saved).toLowerCase();
  const route = memoryRoute(requested).toLowerCase();
  return prefix === "/" || route === prefix || route.startsWith(`${prefix}/`);
}

interface DocRow {
  readonly doc_id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly environment: string | null;
  readonly status: string;
  readonly routes_json: string;
  readonly keywords_json: string;
  readonly body: string;
  readonly updated_at: string;
  readonly sha256: string;
}
const fromRow = (row: DocRow): MemoryDoc =>
  decodeDoc({
    docId: row.doc_id,
    projectId: row.project_id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    ...(row.environment === null ? {} : { environment: row.environment }),
    status: row.status,
    routes: JSON.parse(row.routes_json),
    keywords: JSON.parse(row.keywords_json),
    body: row.body,
    updatedAt: row.updated_at,
  });
const failure = (cause: unknown) =>
  isMemoryError(cause)
    ? cause
    : new ProjectMemoryError({ message: "Could not access Markdown project memory.", cause });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const digest = yield* Digest.Digest;
  const directory = (projectId: ProjectId) =>
    ServerConfig.projectMemoryDirectory(config.stateDir, projectId, path.join);
  const filePath = (doc: Pick<MemoryDoc, "projectId" | "kind" | "slug">) => {
    validateMemorySlug(doc.slug);
    if (doc.kind === "playbook" && doc.slug !== "playbook")
      throw new Error("Playbook slug must be playbook");
    return doc.kind === "playbook"
      ? path.join(directory(doc.projectId), "playbook.md")
      : path.join(directory(doc.projectId), "guides", `${doc.slug}.md`);
  };
  const sync = Effect.fn("MarkdownMemoryStore.sync")(function* (projectId: ProjectId) {
    const root = yield* Effect.try({ try: () => directory(projectId), catch: failure });
    const files: Array<{ path: string; kind: MemoryDoc["kind"]; slug: string }> = [];
    if (yield* fs.exists(path.join(root, "playbook.md")))
      files.push({ path: path.join(root, "playbook.md"), kind: "playbook", slug: "playbook" });
    const guides = path.join(root, "guides");
    if (yield* fs.exists(guides)) {
      for (const name of yield* fs.readDirectory(guides)) {
        if (!name.endsWith(".md")) continue;
        const slug = name.slice(0, -3);
        yield* Effect.try({ try: () => validateMemorySlug(slug), catch: failure });
        files.push({ path: path.join(guides, name), kind: "guide", slug });
      }
    }
    // Parse before the transaction so an invalid file cannot cause a partial index or pruning.
    const scanned = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const markdown = yield* fs.readFileString(file.path);
        const doc = yield* Effect.try({
          try: () => parseMemoryMarkdown(markdown, projectId, file.kind, file.slug),
          catch: failure,
        });
        const hash = Hex.encode(
          yield* digest.digest(Digest.sha256, new TextEncoder().encode(markdown)),
        );
        return { doc, hash };
      }),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const indexed =
          yield* sql<DocRow>`SELECT * FROM memory_docs WHERE project_id = ${projectId}`;
        const hashes = new Map(indexed.map((row) => [row.doc_id, row.sha256]));
        const present = new Set(scanned.map(({ doc }) => doc.docId));
        for (const { doc, hash } of scanned) {
          if (hashes.get(doc.docId) === hash) continue;
          const routesJson = yield* encodeStrings(doc.routes);
          const keywordsJson = yield* encodeStrings(doc.keywords);
          yield* sql`INSERT INTO memory_docs (doc_id, project_id, kind, slug, title, summary, environment, status, routes_json, keywords_json, body, updated_at, sha256)
          VALUES (${doc.docId}, ${projectId}, ${doc.kind}, ${doc.slug}, ${doc.title}, ${doc.summary}, ${doc.environment ?? null}, ${doc.status}, ${routesJson}, ${keywordsJson}, ${doc.body}, ${doc.updatedAt}, ${hash})
          ON CONFLICT(doc_id) DO UPDATE SET title=excluded.title, summary=excluded.summary, environment=excluded.environment, status=excluded.status, routes_json=excluded.routes_json, keywords_json=excluded.keywords_json, body=excluded.body, updated_at=excluded.updated_at, sha256=excluded.sha256`;
          yield* sql`DELETE FROM memory_docs_fts WHERE doc_id = ${doc.docId} AND project_id = ${projectId}`;
          yield* sql`INSERT INTO memory_docs_fts (doc_id, project_id, title, keywords, body) VALUES (${doc.docId}, ${projectId}, ${doc.title}, ${doc.keywords.join(" ")}, ${doc.body})`;
        }
        for (const row of indexed) {
          if (present.has(row.doc_id)) continue;
          yield* sql`DELETE FROM memory_docs_fts WHERE doc_id = ${row.doc_id} AND project_id = ${projectId}`;
          yield* sql`DELETE FROM memory_docs WHERE doc_id = ${row.doc_id} AND project_id = ${projectId}`;
        }
      }),
    );
  }, Effect.mapError(failure));
  const syncProject = Effect.fn("MarkdownMemoryStore.syncProject")((projectId: ProjectId) =>
    sync(projectId).pipe(lock.withPermit),
  );
  const listDocs = Effect.fn("MarkdownMemoryStore.listDocs")(function* (
    projectId: ProjectId,
    environment?: string,
  ) {
    const origin =
      environment === undefined ? null : (memoryEnvironment(environment) ?? environment);
    const rows = yield* sql<DocRow>`SELECT * FROM memory_docs WHERE project_id = ${projectId}
      AND (${origin} IS NULL OR environment IS NULL OR environment = ${origin}) ORDER BY kind, slug`;
    return yield* Effect.try({ try: () => rows.map(fromRow), catch: failure });
  }, Effect.mapError(failure));
  const save = Effect.fn("MarkdownMemoryStore.save")(function* (
    input: MemoryDocInput,
    status: MemoryDoc["status"],
  ) {
    const doc = yield* decodeDocEffect({
      ...input,
      status,
      docId: `${input.projectId}:${input.kind}:${input.slug}`,
    });
    const target = yield* Effect.try({ try: () => filePath(doc), catch: failure });
    if (status === "draft" && (yield* fs.exists(target))) {
      const existing = yield* fs.readFileString(target);
      const confirmed = yield* Effect.try({
        try: () =>
          parseMemoryMarkdown(existing, doc.projectId, doc.kind, doc.slug).status === "confirmed",
        catch: failure,
      });
      if (confirmed)
        return yield* new ProjectMemoryError({
          message: "Agents cannot overwrite confirmed memory.",
        });
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const markdown = yield* Effect.try({ try: () => serializeMemoryMarkdown(doc), catch: failure });
    const temp = yield* fs.makeTempFile({ directory: path.dirname(target), prefix: ".memory-" });
    yield* fs
      .writeFileString(temp, markdown)
      .pipe(
        Effect.andThen(fs.rename(temp, target)),
        Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
      );
    yield* sync(doc.projectId);
    return doc;
  }, Effect.mapError(failure));
  const migrateLegacyUnderstandingIfEmpty = Effect.fn(
    "MarkdownMemoryStore.migrateLegacyUnderstandingIfEmpty",
  )(function* (projectId: ProjectId) {
    const target = yield* Effect.try({
      try: () => filePath({ projectId, kind: "playbook", slug: "playbook" }),
      catch: failure,
    });
    if (yield* fs.exists(target)) return;
    const rows = yield* sql<{
      statement: string;
      updated_at: string;
    }>`SELECT statement, updated_at FROM project_memory_understanding WHERE project_id = ${projectId} AND status = 'confirmed' ORDER BY updated_at, item_id`;
    if (rows.length === 0) return;
    const markdown = serializeMemoryMarkdown({
      docId: `${projectId}:playbook:playbook`,
      projectId,
      kind: "playbook",
      slug: "playbook",
      title: "Project playbook",
      summary: "Confirmed understanding from earlier runs",
      status: "confirmed",
      routes: [],
      keywords: [],
      body: rows.map((row) => `- ${row.statement}`).join("\n"),
      updatedAt: rows.at(-1)!.updated_at,
    });
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    // Exclusive creation also preserves a playbook created externally during migration.
    yield* fs.writeFileString(target, markdown, { flag: "wx" });
    yield* sync(projectId);
  }, Effect.mapError(failure));
  return MarkdownMemoryStore.of({
    syncProject,
    listDocs,
    saveUserDoc: Effect.fn("MarkdownMemoryStore.saveUserDoc")((input) =>
      save(input, "confirmed").pipe(lock.withPermit),
    ),
    saveDraftDoc: Effect.fn("MarkdownMemoryStore.saveDraftDoc")((input) =>
      save(input, "draft").pipe(lock.withPermit),
    ),
    migrateLegacyUnderstandingIfEmpty: Effect.fn("MarkdownMemoryStore.migrateLegacy")((projectId) =>
      migrateLegacyUnderstandingIfEmpty(projectId).pipe(lock.withPermit),
    ),
    searchDocs: Effect.fn("MarkdownMemoryStore.searchDocs")(function* (
      projectId,
      query,
      options = {},
    ) {
      const match = sanitizeMemoryQuery(query);
      if (match === "") return [];
      const origin =
        options.environment === undefined
          ? null
          : (memoryEnvironment(options.environment) ?? options.environment);
      const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 10) || 10));
      const rows =
        yield* sql<DocRow>`SELECT d.* FROM memory_docs_fts JOIN memory_docs d ON d.doc_id = memory_docs_fts.doc_id
        WHERE memory_docs_fts MATCH ${match} AND d.project_id = ${projectId} AND memory_docs_fts.project_id = ${projectId}
        AND (${origin} IS NULL OR d.environment IS NULL OR d.environment = ${origin})
        ORDER BY bm25(memory_docs_fts, 0, 0, 5.0, 4.0, 1.0) * CASE d.status WHEN 'confirmed' THEN 1.5 ELSE 1.0 END, d.doc_id LIMIT ${limit}`;
      return yield* Effect.try({ try: () => rows.map(fromRow), catch: failure });
    }, Effect.mapError(failure)),
    matchDocsByRoutes: Effect.fn("MarkdownMemoryStore.matchDocsByRoutes")(
      function* (projectId, routes, environment) {
        const docs = yield* listDocs(projectId, environment);
        return docs
          .filter((doc) =>
            doc.routes.some((saved) =>
              routes.some(
                (route) =>
                  (memoryEnvironment(route) === null ||
                    doc.environment === undefined ||
                    memoryEnvironment(route) === doc.environment) &&
                  memoryRouteMatches(saved, route),
              ),
            ),
          )
          .toSorted((a, b) => Number(b.status === "confirmed") - Number(a.status === "confirmed"));
      },
    ),
  });
});
export const layer = Layer.effect(MarkdownMemoryStore, make);
