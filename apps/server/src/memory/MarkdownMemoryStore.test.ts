import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, type MemoryDoc } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Store from "./MarkdownMemoryStore.ts";

const projectId = ProjectId.make("shop");
const doc = (slug = "checkout", overrides: Partial<MemoryDoc> = {}): MemoryDoc => ({
  docId: `shop:guide:${slug}`,
  projectId,
  kind: "guide",
  slug,
  title: "Checkout",
  summary: "Buy products",
  status: "draft",
  routes: ["/checkout"],
  keywords: ["purchase"],
  body: "A cart is required.\n",
  updatedAt: "2026-11-23T00:00:00Z",
  ...overrides,
});
const withStore = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Store.MarkdownMemoryStore
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | Scope.Scope
  >,
) =>
  Effect.scoped(
    body.pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "markdown-memory-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

it("round trips YAML frontmatter, Unicode and Markdown; rejects malformed documents and traversal", () => {
  const input = doc("checkout", {
    title: 'Checkout: "orders"',
    body: "# Guide\n---\nKeep this body.\n",
    keywords: ["quotes", "multi word"],
  });
  expect(
    Store.parseMemoryMarkdown(Store.serializeMemoryMarkdown(input), projectId, "guide", "checkout"),
  ).toEqual(input);
  for (const slug of ["../secrets", "/absolute", "a/b", "a\\b", "a.md", "", "A", "a%2fb"])
    expect(() => Store.validateMemorySlug(slug)).toThrow();
  for (const markdown of [
    "no frontmatter",
    "---\nstatus: draft\n---\nbody",
    "---\ntitle: a\ntitle: b\n---\n",
  ])
    expect(() => Store.parseMemoryMarkdown(markdown, projectId, "guide", "checkout")).toThrow();
});

it.effect(
  "saves, incrementally indexes external edits, protects confirmed files and prunes deleted files within a project",
  () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store.MarkdownMemoryStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        yield* store.saveUserDoc(doc());
        yield* store.saveDraftDoc(doc("other", { projectId: ProjectId.make("other") }));
        const conflict = yield* Effect.exit(
          store.saveDraftDoc(doc("checkout", { body: "overwrite" })),
        );
        expect(Exit.isFailure(conflict)).toBe(true);
        expect((yield* store.listDocs(projectId))[0]?.status).toBe("confirmed");
        const guidePath = path.join(
          ServerConfig.projectMemoryDirectory(config.stateDir, projectId, path.join),
          "guides",
          "checkout.md",
        );
        const before = yield* sql`SELECT sha256 FROM memory_docs WHERE project_id = ${projectId}`;
        yield* store.syncProject(projectId);
        expect(yield* sql`SELECT sha256 FROM memory_docs WHERE project_id = ${projectId}`).toEqual(
          before,
        );
        yield* fs.writeFileString(
          guidePath,
          Store.serializeMemoryMarkdown(
            doc("checkout", { body: "Inventory zebra", status: "confirmed" }),
          ),
        );
        yield* store.syncProject(projectId);
        expect((yield* store.searchDocs(projectId, "zebra"))[0]?.body).toBe("Inventory zebra");
        expect(yield* store.searchDocs(projectId, "required")).toEqual([]);
        yield* fs.remove(guidePath);
        yield* store.syncProject(projectId);
        expect(yield* store.listDocs(projectId)).toEqual([]);
        expect(yield* store.searchDocs(projectId, "zebra")).toEqual([]);
        expect(yield* store.listDocs(ProjectId.make("other"))).toHaveLength(1);
      }),
    ),
);

it.effect(
  "executes hostile FTS syntax as text and ranks title/keywords and confirmed docs using BM25",
  () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store.MarkdownMemoryStore;
        yield* store.saveDraftDoc(doc("title", { title: "zebra", keywords: [], body: "other" }));
        yield* store.saveDraftDoc(doc("body", { title: "other", keywords: [], body: "zebra" }));
        yield* store.saveDraftDoc(
          doc("keywords", { title: "other", keywords: ["zebra"], body: "other" }),
        );
        yield* store.saveUserDoc(doc("confirmed", { title: "zebra", keywords: [], body: "other" }));
        expect((yield* store.searchDocs(projectId, "zebra")).map((item) => item.slug)).toEqual([
          "confirmed",
          "title",
          "keywords",
          "body",
        ]);
        for (const query of [
          'https://shop.test/a-b?q="zebra"',
          'zebra OR NOT (NEAR("',
          "title:zebra* - zebra",
          '"',
          "---",
          "AND",
          "??",
        ])
          yield* store.searchDocs(projectId, query);
        expect(yield* store.searchDocs(projectId, '"')).toEqual([]);
        expect(yield* store.searchDocs(ProjectId.make("other"), "zebra")).toEqual([]);
      }),
    ),
);

it.effect(
  "matches normalized route prefixes and generic/environment-specific docs without sibling collisions",
  () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store.MarkdownMemoryStore;
        yield* store.saveDraftDoc(doc("global", { routes: ["/orders/"] }));
        yield* store.saveDraftDoc(
          doc("prod", { environment: "https://shop.test", routes: ["/orders/42"] }),
        );
        yield* store.saveDraftDoc(
          doc("staging", { environment: "https://staging.shop.test", routes: ["/orders"] }),
        );
        expect(
          (yield* store.matchDocsByRoutes(
            projectId,
            ["https://shop.test/orders/99/details?x=1"],
            "https://shop.test/",
          )).map((item) => item.slug),
        ).toEqual(["global", "prod"]);
        expect(
          yield* store.matchDocsByRoutes(projectId, ["/orders-extra"], "https://shop.test"),
        ).toEqual([]);
        expect(
          (yield* store.searchDocs(projectId, "Checkout", { environment: "https://shop.test" }))
            .map((item) => item.slug)
            .sort(),
        ).toEqual(["global", "prod"]);
      }),
    ),
);

it.effect("exports only confirmed legacy understanding once and leaves legacy rows intact", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store.MarkdownMemoryStore;
      const sql = yield* SqlClient.SqlClient;
      for (const status of ["confirmed", "hypothesis"])
        yield* sql`INSERT INTO project_memory_understanding (item_id, project_id, kind, statement, status, author, created_at, updated_at) VALUES (${status}, ${projectId}, 'rule', ${status + " rule"}, ${status}, 'user', '2026-11-23', '2026-11-23')`;
      yield* store.migrateLegacyUnderstandingIfEmpty(projectId);
      yield* store.migrateLegacyUnderstandingIfEmpty(projectId);
      const docs = yield* store.listDocs(projectId);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.body).toBe("- confirmed rule");
      expect(docs[0]?.status).toBe("confirmed");
      expect(yield* sql`SELECT * FROM project_memory_understanding`).toHaveLength(2);
      yield* store.saveUserDoc(doc("playbook", { kind: "playbook", body: "User edit" }));
      yield* store.migrateLegacyUnderstandingIfEmpty(projectId);
      expect((yield* store.listDocs(projectId))[0]?.body).toBe("User edit");
    }),
  ),
);
