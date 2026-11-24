import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { parse, stringify } from "yaml";
import { MemoryDoc, MemoryProposal, ProjectMemoryError, type ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { memoryEnvironment, memoryRoute } from "./projectMemoryFacts.ts";
import { scrubSecrets, type ProposalDraft } from "./memoryProposals.ts";
import {
  normalizeMemoryEnvironment,
  makeMemoryEnvironmentResolver,
  memoryEnvironmentMatches,
} from "./memoryEnvironment.ts";

const decodeDoc = Schema.decodeUnknownSync(MemoryDoc);
const validateDoc = Schema.decodeSync(MemoryDoc);
const decodeDocEffect = Schema.decodeEffect(MemoryDoc);
const isMemoryError = Schema.is(ProjectMemoryError);
const encodeStrings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

type MemoryDocInput = Omit<MemoryDoc, "docId" | "status" | "environment"> & {
  readonly environment?: string | null | undefined;
};
type SearchOptions = { readonly environment?: string | null; readonly limit?: number };

export class MarkdownMemoryStore extends Context.Service<
  MarkdownMemoryStore,
  {
    readonly syncProject: (projectId: ProjectId) => Effect.Effect<void, ProjectMemoryError>;
    readonly listDocs: (
      projectId: ProjectId,
      environment?: string | null,
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
      environment?: string | null,
    ) => Effect.Effect<ReadonlyArray<MemoryDoc>, ProjectMemoryError>;
    /** Queues a run's drafts for review; pending ones from the same run and target are replaced. */
    readonly proposeDocs: (
      projectId: ProjectId,
      sourceRunId: string,
      drafts: ReadonlyArray<ProposalDraft>,
    ) => Effect.Effect<ReadonlyArray<MemoryProposal>, ProjectMemoryError>;
    readonly listProposals: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<MemoryProposal>, ProjectMemoryError>;
    /**
     * Approving adds the proposal to its document as the user's own edit. A confirmed document
     * changes only with `replaceConfirmed`, the user's explicit go-ahead.
     */
    readonly resolveProposal: (input: {
      readonly projectId: ProjectId;
      readonly proposalId: string;
      readonly decision: "approve" | "dismiss";
      readonly replaceConfirmed?: boolean | undefined;
    }) => Effect.Effect<MemoryProposal, ProjectMemoryError>;
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
  const environment = "environment" in metadata ? metadata.environment : undefined;
  return decodeDoc({
    summary: "",
    routes: [],
    keywords: [],
    ...metadata,
    environment:
      typeof environment === "string" || environment == null
        ? (normalizeMemoryEnvironment(environment) ?? undefined)
        : environment,
    docId: `${projectId}:${kind}:${slug}`,
    projectId,
    kind,
    slug,
    body: match[2]!,
  });
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
interface ProposalRow {
  readonly proposal_id: string;
  readonly project_id: string;
  readonly target_doc_id: string;
  readonly kind: string;
  readonly title: string;
  readonly proposed_markdown: string;
  readonly rationale: string;
  readonly source_run_id: string | null;
  readonly status: string;
  readonly created_at: string;
}
const decodeProposal = Schema.decodeUnknownSync(MemoryProposal);
const fromProposalRow = (row: ProposalRow): MemoryProposal =>
  decodeProposal({
    proposalId: row.proposal_id,
    projectId: row.project_id,
    targetDocId: row.target_doc_id,
    kind: row.kind,
    title: row.title,
    proposedMarkdown: row.proposed_markdown,
    rationale: row.rationale,
    ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
    status: row.status,
    createdAt: row.created_at,
  });
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
  const resolveEnvironment = yield* makeMemoryEnvironmentResolver;
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
        files.push({ path: path.join(guides, name), kind: "guide", slug: name.slice(0, -3) });
      }
    }
    // Files are hand-edited: one bad file is skipped, and keeps its last good index row, rather
    // than taking every other guide, every save and the Memory screen down with it.
    const kept = new Set<string>();
    const scanned = (yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const markdown = yield* fs.readFileString(file.path);
        const doc = yield* Effect.try({
          try: () => parseMemoryMarkdown(markdown, projectId, file.kind, file.slug),
          catch: failure,
        });
        const hash = Hex.encode(
          yield* digest.digest(Digest.sha256, new TextEncoder().encode(markdown)),
        );
        return [{ doc, hash }];
      }).pipe(
        Effect.catch((error) => {
          kept.add(`${projectId}:${file.kind}:${file.slug}`);
          return Effect.logWarning("Skipped an invalid memory file", {
            path: file.path,
            error,
          }).pipe(Effect.as([]));
        }),
      ),
    )).flat();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const indexed =
          yield* sql<DocRow>`SELECT * FROM memory_docs WHERE project_id = ${projectId}`;
        const indexedById = new Map(indexed.map((row) => [row.doc_id, row]));
        const present = new Set([...kept, ...scanned.map(({ doc }) => doc.docId)]);
        for (const { doc, hash } of scanned) {
          const previous = indexedById.get(doc.docId);
          if (previous?.sha256 === hash && previous.environment === (doc.environment ?? null))
            continue;
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
    environment?: string | null,
  ) {
    const scope = yield* resolveEnvironment(projectId, environment);
    const rows = yield* sql<DocRow>`SELECT * FROM memory_docs WHERE project_id = ${projectId}
      AND (${scope.appliedEnvironment} IS NULL OR environment IS NULL OR ${sql.in("environment", scope.environments)}) ORDER BY kind, slug`;
    return yield* Effect.try({ try: () => rows.map(fromRow), catch: failure });
  }, Effect.mapError(failure));
  const save = Effect.fn("MarkdownMemoryStore.save")(function* (
    input: MemoryDocInput,
    status: MemoryDoc["status"],
  ) {
    const doc = yield* decodeDocEffect({
      ...input,
      // Memory files are shared and committed; credentials belong in the project's saved secrets.
      title: scrubSecrets(input.title),
      summary: scrubSecrets(input.summary),
      body: scrubSecrets(input.body),
      environment: normalizeMemoryEnvironment(input.environment) ?? undefined,
      status,
      docId: `${input.projectId}:${input.kind}:${input.slug}`,
    });
    const target = yield* Effect.try({ try: () => filePath(doc), catch: failure });
    const existing = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : null;
    if (status === "draft" && existing !== null) {
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
    let replaced = false;
    yield* fs.writeFileString(temp, markdown).pipe(
      Effect.andThen(fs.rename(temp, target)),
      Effect.tap(() =>
        Effect.sync(() => {
          replaced = true;
        }),
      ),
      Effect.andThen(sync(doc.projectId)),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (replaced) {
            if (existing === null) yield* fs.remove(target);
            else {
              yield* fs.writeFileString(temp, existing);
              yield* fs.rename(temp, target);
            }
          }
          return yield* Effect.failCause(cause);
        }),
      ),
      Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
      Effect.uninterruptible,
    );
    return doc;
  }, Effect.mapError(failure));
  const migrateLegacyUnderstandingIfEmpty = Effect.fn(
    "MarkdownMemoryStore.migrateLegacyUnderstandingIfEmpty",
  )(function* (projectId: ProjectId) {
    const target = yield* Effect.try({
      try: () => filePath({ projectId, kind: "playbook", slug: "playbook" }),
      catch: failure,
    });
    // Once exported, a playbook the user later deletes stays deleted.
    const marker = path.join(path.dirname(target), ".legacy-understanding-exported");
    if (yield* fs.exists(marker)) return;
    const done = fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(marker, "")));
    if (yield* fs.exists(target)) return yield* done;
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
    yield* done;
    yield* sync(projectId);
  }, Effect.mapError(failure));
  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const readProposals = (projectId: ProjectId, proposalId?: string) =>
    sql<ProposalRow>`SELECT * FROM memory_proposals WHERE project_id = ${projectId}
      AND (${proposalId ?? null} IS NULL OR proposal_id = ${proposalId ?? null})
      ORDER BY created_at DESC, proposal_id`.pipe(Effect.map((rows) => rows.map(fromProposalRow)));
  const proposeDocs = Effect.fn("MarkdownMemoryStore.proposeDocs")(function* (
    projectId: ProjectId,
    sourceRunId: string,
    drafts: ReadonlyArray<ProposalDraft>,
  ) {
    const createdAt = yield* nowIso;
    for (const draft of drafts) {
      const slug = yield* Effect.try({ try: () => validateMemorySlug(draft.slug), catch: failure });
      const doc = yield* decodeDocEffect({
        docId: `${projectId}:${draft.kind}:${slug}`,
        projectId,
        kind: draft.kind,
        slug,
        title: scrubSecrets(draft.title),
        summary: scrubSecrets(draft.summary),
        ...(draft.environment === null
          ? {}
          : { environment: normalizeMemoryEnvironment(draft.environment) ?? undefined }),
        status: "draft",
        routes: draft.routes,
        keywords: [],
        body: scrubSecrets(draft.body),
        updatedAt: createdAt,
      });
      const proposalId = `${sourceRunId}:${doc.docId}`;
      // A follow-up turn finishes the run again; a reviewed proposal keeps its decision.
      yield* sql`INSERT INTO memory_proposals (proposal_id, project_id, target_doc_id, kind, title, proposed_markdown, rationale, source_run_id, status, created_at)
        VALUES (${proposalId}, ${projectId}, ${doc.docId}, ${doc.kind}, ${doc.title}, ${serializeMemoryMarkdown(doc)}, ${scrubSecrets(draft.rationale)}, ${sourceRunId}, 'pending', ${createdAt})
        ON CONFLICT (proposal_id) DO UPDATE SET title = excluded.title, proposed_markdown = excluded.proposed_markdown,
          rationale = excluded.rationale, created_at = excluded.created_at
        WHERE memory_proposals.status = 'pending'`;
    }
    return (yield* readProposals(projectId)).filter(
      (proposal) => proposal.sourceRunId === sourceRunId,
    );
  }, Effect.mapError(failure));
  const resolveProposal = Effect.fn("MarkdownMemoryStore.resolveProposal")(function* (input: {
    readonly projectId: ProjectId;
    readonly proposalId: string;
    readonly decision: "approve" | "dismiss";
    readonly replaceConfirmed?: boolean | undefined;
  }) {
    const [proposal] = yield* readProposals(input.projectId, input.proposalId);
    if (proposal === undefined || proposal.status !== "pending")
      return yield* new ProjectMemoryError({ message: "That proposal is no longer pending." });
    if (input.decision === "approve") {
      const slug = proposal.targetDocId.split(":").at(-1)!;
      const proposed = yield* Effect.try({
        try: () =>
          parseMemoryMarkdown(proposal.proposedMarkdown, input.projectId, proposal.kind, slug),
        catch: failure,
      });
      const target = yield* Effect.try({ try: () => filePath(proposed), catch: failure });
      const existing = (yield* fs.exists(target))
        ? yield* fs.readFileString(target).pipe(
            Effect.flatMap((markdown) =>
              Effect.try({
                try: () => parseMemoryMarkdown(markdown, input.projectId, proposal.kind, slug),
                catch: failure,
              }),
            ),
          )
        : null;
      if (existing?.status === "confirmed" && input.replaceConfirmed !== true)
        return yield* new ProjectMemoryError({
          message: `"${existing.title}" is confirmed. Approve again with replaceConfirmed to add this proposal to it.`,
        });
      const { docId: _docId, status: _status, ...fields } = proposed;
      yield* save(
        existing === null
          ? { ...fields, updatedAt: yield* nowIso }
          : {
              ...existing,
              routes: [...new Set([...existing.routes, ...proposed.routes])],
              body: `${existing.body.trimEnd()}

${proposed.body}`,
              updatedAt: yield* nowIso,
            },
        "confirmed",
      );
    }
    yield* sql`UPDATE memory_proposals SET status = ${input.decision === "approve" ? "approved" : "dismissed"}
      WHERE project_id = ${input.projectId} AND proposal_id = ${input.proposalId}`;
    return (yield* readProposals(input.projectId, input.proposalId))[0]!;
  }, Effect.mapError(failure));
  return MarkdownMemoryStore.of({
    proposeDocs: Effect.fn("MarkdownMemoryStore.proposeDocsLocked")(
      (projectId, sourceRunId, drafts) =>
        proposeDocs(projectId, sourceRunId, drafts).pipe(lock.withPermit),
    ),
    listProposals: Effect.fn("MarkdownMemoryStore.listProposals")((projectId) =>
      readProposals(projectId).pipe(Effect.mapError(failure)),
    ),
    resolveProposal: Effect.fn("MarkdownMemoryStore.resolveProposalLocked")((input) =>
      resolveProposal(input).pipe(lock.withPermit),
    ),
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
      const scope = yield* resolveEnvironment(projectId, options.environment);
      const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 10) || 10));
      const rows =
        yield* sql<DocRow>`SELECT d.* FROM memory_docs_fts JOIN memory_docs d ON d.doc_id = memory_docs_fts.doc_id
        WHERE memory_docs_fts MATCH ${match} AND d.project_id = ${projectId} AND memory_docs_fts.project_id = ${projectId}
        AND (${scope.appliedEnvironment} IS NULL OR d.environment IS NULL OR ${sql.in("d.environment", scope.environments)})
        ORDER BY bm25(memory_docs_fts, 0, 0, 5.0, 4.0, 1.0) * CASE d.status WHEN 'confirmed' THEN 1.5 ELSE 1.0 END, d.doc_id LIMIT ${limit}`;
      return yield* Effect.try({ try: () => rows.map(fromRow), catch: failure });
    }, Effect.mapError(failure)),
    matchDocsByRoutes: Effect.fn("MarkdownMemoryStore.matchDocsByRoutes")(
      function* (projectId, routes, environment) {
        const docs = yield* listDocs(projectId, environment);
        const specificity = (doc: MemoryDoc) =>
          Math.max(
            ...doc.routes
              .filter((saved) => routes.some((route) => memoryRouteMatches(saved, route)))
              .map((saved) => memoryRoute(saved).length),
          );
        return docs
          .filter((doc) =>
            doc.routes.some((saved) =>
              routes.some(
                (route) =>
                  memoryEnvironmentMatches(memoryEnvironment(route), doc.environment) &&
                  memoryRouteMatches(saved, route),
              ),
            ),
          )
          .toSorted(
            (a, b) =>
              specificity(b) - specificity(a) ||
              Number(b.environment !== undefined) - Number(a.environment !== undefined) ||
              Number(b.status === "confirmed") - Number(a.status === "confirmed"),
          );
      },
    ),
  });
});
export const layer = Layer.effect(MarkdownMemoryStore, make);
