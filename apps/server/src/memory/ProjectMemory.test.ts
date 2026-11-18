import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as MemoryEmbedder from "./MemoryEmbedder.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, type ProjectMemoryFactInput } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import { memoryRoute } from "./projectMemoryFacts.ts";

const shop = ProjectId.make("shop");
const blog = ProjectId.make("blog");
const threadId = ThreadId.make("thread-memory-1");

const page = (url: string): QaRuns.QaPageCapture => ({
  url,
  title: "Page",
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  consoleEntries: [{ level: "error", text: "Boom", timestamp: "t" }],
  networkEntries: [],
  actionTimeline: [],
});

let randomSeed = 0;
const withMemory = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | QaRuns.QaRuns
    | ProjectMemory.ProjectMemory
    | ProjectUnderstanding.ProjectUnderstanding
    | FileSystem.FileSystem
    | SqlClient.SqlClient
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "exploro-memory-" });
    return yield* body.pipe(
      Effect.provide(
        QaRuns.layer.pipe(
          Layer.provideMerge(
            ProjectMemory.layer.pipe(
              Layer.provideMerge(
                ProjectUnderstanding.layer.pipe(Layer.provide(MemoryEmbedder.layerUnavailable)),
              ),
            ),
          ),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill((randomSeed += 1) % 256)),
            ),
          ),
        ),
      ),
    );
  });

/** A finished run in `projectId` with one scenario per entry. */
const finishedRun = (
  projectId: ProjectId | null,
  scenarios: ReadonlyArray<{
    scenario: string;
    verdict: "PASS" | "FAIL";
    url: string;
    requests?: QaRuns.QaPageCapture["networkEntries"];
  }>,
  thread = threadId,
) =>
  Effect.gen(function* () {
    const qaRuns = yield* QaRuns.QaRuns;
    for (const { scenario, verdict, url, requests = [] } of scenarios) {
      yield* qaRuns.recordEvidence(
        thread,
        {
          scenario,
          verdict,
          note: `${scenario}: ${verdict}`,
          severity: verdict === "FAIL" ? "major" : undefined,
        },
        { ...page(url), networkEntries: requests },
      );
    }
    return (yield* qaRuns.finishRun(thread, { projectId }))!;
  });

const fact = (overrides: Partial<ProjectMemoryFactInput> = {}): ProjectMemoryFactInput => ({
  environment: "https://shop.test",
  route: "/login",
  kind: "validation",
  key: "empty email",
  value: "Email is required",
  evidence: [],
  author: "agent",
  ...overrides,
});

it.layer(NodeServices.layer)("ProjectMemory", (it) => {
  it.effect("maps only this project's facts and reflects newly recorded runs and deletion", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        assert.deepStrictEqual((yield* memory.map(shop)).environments, []);
        yield* memory.putFact(blog, fact({ route: "/private" }));
        const saved = yield* memory.putFact(shop, fact());
        assert.strictEqual(
          (yield* memory.map(shop)).environments[0]?.tree.children[0]?.page?.coverage,
          "seen",
        );
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        yield* understanding.saveItems(
          shop,
          [
            {
              ref: "session",
              itemId: null,
              kind: "dependency",
              statement: "signed-in session",
              citedFactIds: [saved!.factId],
              dependsOn: [],
              author: "user",
            },
          ],
          { environment: "https://shop.test" },
        );
        assert.deepStrictEqual(
          (yield* memory.map(shop)).environments[0]?.tree.children[0]?.page?.needs,
          ["signed-in session"],
        );
        yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login" },
        ]);
        const mapped = yield* memory.map(shop);
        assert.strictEqual(mapped.environments[0]?.tree.children.length, 1);
        assert.strictEqual(mapped.environments[0]?.tree.children[0]?.page?.coverage, "tested");
        assert.strictEqual(mapped.environments[0]?.tree.children[0]?.page?.passCount, 1);
        yield* memory.deleteFact(shop, saved!.factId);
        assert.strictEqual(
          (yield* memory.map(shop)).environments[0]?.tree.children[0]?.page?.details.length,
          0,
        );
        assert.strictEqual(
          (yield* memory.map(blog)).environments[0]?.tree.children[0]?.route,
          "/private",
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
          INSERT INTO project_memory_facts (fact_id, project_id, environment, route, kind, fact_key,
            value, detail, page_url, evidence_json, app_version, author, status, observed_at, superseded_by)
          SELECT 'bulk-' || n, ${shop}, 'https://shop.test', '/login', 'result', 'bulk-' || n,
            'PASS', NULL, NULL, '[]', NULL, 'server', 'current', '2026-01-01T00:00:00Z', NULL FROM seq`;
        assert.strictEqual(
          (yield* memory.map(shop)).environments[0]?.tree.children[0]?.page?.passCount,
          502,
        );
      }),
    ),
  );
  it.effect("writes a result fact per scenario when a project's run finishes", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const run = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login?next=/" },
          { scenario: "Order opens", verdict: "FAIL", url: "https://shop.test/orders/4812" },
          // Opening a guarded page redirects; the result belongs to the page that was opened.
          {
            scenario: "Account needs a session",
            verdict: "PASS",
            url: "https://shop.test/login",
            requests: [
              {
                url: "https://shop.test/account",
                method: "GET",
                status: 302,
                failed: false,
                timestamp: "t",
              },
              {
                url: "https://shop.test/login",
                method: "GET",
                status: 200,
                failed: false,
                timestamp: "t",
              },
            ],
          },
          // Submitting a form redirects too, but the result is about where it landed.
          {
            scenario: "Sign in lands on the dashboard",
            verdict: "PASS",
            url: "https://shop.test/dashboard",
            requests: [
              {
                url: "https://shop.test/login",
                method: "POST",
                status: 303,
                failed: false,
                timestamp: "t",
              },
              {
                url: "https://shop.test/dashboard",
                method: "GET",
                status: 200,
                failed: false,
                timestamp: "t",
              },
            ],
          },
        ]);
        const facts = yield* memory.lookupFacts(shop, { kind: "result" });
        assert.deepStrictEqual(
          facts.map((row) => [row.route, row.key, row.value, row.author]).toSorted(),
          [
            ["/account", "Account needs a session", "PASS", "server"],
            ["/dashboard", "Sign in lands on the dashboard", "PASS", "server"],
            ["/login", "Login works", "PASS", "server"],
            ["/orders/:id", "Order opens", "FAIL major", "server"],
          ],
        );
        const failed = yield* memory.lookupFacts(shop, { openFailures: true });
        assert.deepStrictEqual(
          failed.map((row) => row.key),
          ["Order opens"],
        );
        assert.strictEqual(failed[0]?.environment, "https://shop.test");
        assert.strictEqual(failed[0]?.pageUrl, "https://shop.test/orders/4812");
        assert.deepStrictEqual(
          failed[0]?.evidence.map((ref) => [ref.runId, ref.scenarioIndex, ref.type]),
          [
            [run.runId, 1, "screenshot"],
            [run.runId, 1, "console"],
            [run.runId, 1, "network"],
          ],
        );
      }),
    ),
  );

  it.effect("writes nothing for a run without a project", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const run = yield* finishedRun(null, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login" },
        ]);
        assert.strictEqual(yield* memory.recordRun({ ...run, projectId: null }), 0);
        assert.deepStrictEqual(yield* memory.lookupFacts(shop, { kind: "result" }), []);
      }),
    ),
  );

  it.effect("supersedes on the same key and keeps the history", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const first = yield* memory.putFact(shop, fact());
        const second = yield* memory.putFact(
          shop,
          fact({ route: "https://shop.test/login?step=2", value: "Enter your email" }),
        );
        assert.deepStrictEqual(
          (yield* memory.lookupFacts(shop, { route: "/login" })).map((row) => row.value),
          ["Enter your email"],
        );
        const history = yield* memory.lookupFacts(shop, { status: "superseded" });
        assert.deepStrictEqual(
          history.map((row) => [row.factId, row.supersededBy]),
          [[first!.factId, second!.factId]],
        );
      }),
    ),
  );

  it.effect("looks facts up by exact keys only and flags other environments and versions", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        yield* memory.putFact(shop, fact({ appVersion: "1.2" }));
        yield* memory.putFact(shop, fact({ environment: "https://staging.shop.test/login" }));
        yield* memory.putFact(shop, fact({ kind: "control", key: "submit", value: "Sign in" }));

        const keys = (
          lookup: Parameters<ProjectMemory.ProjectMemory["Service"]["lookupFacts"]>[1],
        ) =>
          memory
            .lookupFacts(shop, lookup)
            .pipe(
              Effect.map((rows) =>
                rows.map((row) => `${row.environment} ${row.kind} ${row.key}`).toSorted(),
              ),
            );

        assert.deepStrictEqual(yield* keys({ environment: "https://staging.shop.test" }), [
          "https://staging.shop.test validation empty email",
        ]);
        assert.deepStrictEqual(yield* keys({ kind: "control" }), [
          "https://shop.test control submit",
        ]);
        assert.deepStrictEqual(yield* keys({ key: "empty" }), []);
        assert.deepStrictEqual(yield* keys({ route: "/log" }), []);

        const outdated = yield* memory.lookupFacts(shop, {
          kind: "validation",
          testing: { environment: "https://shop.test/cart", appVersion: "1.3" },
        });
        assert.deepStrictEqual(
          outdated.map((row) => [row.environment, row.mayBeOutdated]).toSorted(),
          [
            ["https://shop.test", true],
            ["https://staging.shop.test", true],
          ],
        );
        const sameVersion = yield* memory.lookupFacts(shop, {
          environment: "https://shop.test",
          kind: "validation",
          testing: { environment: "https://shop.test", appVersion: "1.2" },
        });
        assert.deepStrictEqual(
          sameVersion.map((row) => row.mayBeOutdated),
          [false],
        );
      }),
    ),
  );

  it.effect("remembers an interrupted or project-less run after the thread joins a project", () =>
    withMemory(
      Effect.gen(function* () {
        const runs = yield* QaRuns.QaRuns;
        const memory = yield* ProjectMemory.ProjectMemory;
        const run = yield* finishedRun(null, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login" },
        ]);
        const saved = yield* runs.rememberRun(threadId, run.runId, shop);
        assert.strictEqual(saved.projectId, shop);
        assert.strictEqual((yield* memory.lookupFacts(shop, { runId: run.runId })).length, 1);
        yield* runs.rememberRun(threadId, run.runId, shop);
        assert.strictEqual((yield* memory.listFacts(shop, 100)).length, 1);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runs.rememberRun(threadId, run.runId, blog))),
        );
        yield* runs.recordEvidence(
          threadId,
          { scenario: "Interrupted", verdict: "PASS", note: "Observed" },
          page("https://shop.test/cart"),
        );
        const open = (yield* runs.openRun(threadId))!;
        const interrupted = yield* runs.rememberRun(threadId, open.runId, shop);
        assert.isNotNull(interrupted.finishedAt);
        assert.strictEqual((yield* memory.lookupFacts(shop, { runId: open.runId })).length, 1);
      }),
    ),
  );

  it.effect("saving older runs preserves newer observations and version changes", () =>
    withMemory(
      Effect.gen(function* () {
        const runs = yield* QaRuns.QaRuns;
        const memory = yield* ProjectMemory.ProjectMemory;
        yield* memory.putFact(
          shop,
          fact({
            kind: "data",
            route: "/",
            key: "Tested app version",
            value: "1",
            appVersion: "1",
            author: "user",
          }),
        );
        const older = yield* finishedRun(null, [
          { scenario: "Login", verdict: "FAIL", url: "https://shop.test/login" },
        ]);
        yield* TestClock.adjust("1 second");
        yield* memory.putFact(
          shop,
          fact({
            kind: "data",
            route: "/",
            key: "Tested app version",
            value: "2",
            appVersion: "2",
            author: "user",
          }),
        );
        yield* finishedRun(shop, [
          { scenario: "Login", verdict: "PASS", url: "https://shop.test/login" },
        ]);
        yield* runs.rememberRun(threadId, older.runId, shop);
        const current = yield* memory.lookupFacts(shop, { kind: "result" });
        assert.deepStrictEqual(
          current.map((row) => [row.value, row.appVersion]),
          [["PASS", "2"]],
        );
        const history = yield* memory.lookupFacts(shop, { kind: "result", status: "superseded" });
        assert.strictEqual(history[0]?.appVersion, "1");
        assert.strictEqual(history[0]?.supersededBy, current[0]?.factId);
      }),
    ),
  );

  it.effect("retains the generated brief size separately for each thread", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        assert.isNull(yield* memory.briefUsage(threadId));
        yield* memory.recordBriefUsage(threadId, "First brief");
        assert.deepStrictEqual(yield* memory.briefUsage(threadId), {
          characters: 11,
          estimatedTokens: 3,
        });
        assert.isNull(yield* memory.briefUsage(ThreadId.make("other-thread")));
        yield* memory.recordBriefUsage(threadId, "");
        assert.deepStrictEqual(yield* memory.briefUsage(threadId), {
          characters: 0,
          estimatedTokens: 0,
        });
      }),
    ),
  );

  it.effect("stales earlier app versions only on the observed project's environment", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const first = yield* memory.putFact(shop, fact({ appVersion: "1.2" }));
        const unversioned = yield* memory.putFact(shop, fact({ key: "unversioned" }));
        yield* memory.putFact(
          shop,
          fact({ environment: "https://staging.shop.test", appVersion: "1.2" }),
        );
        yield* memory.putFact(blog, fact({ appVersion: "1.2" }));
        yield* memory.putFact(shop, fact({ key: "app version", appVersion: "1.3", value: "1.3" }));
        assert.deepStrictEqual(
          (yield* memory.lookupFacts(shop, { status: "stale" }))
            .map((row) => row.factId)
            .toSorted(),
          [first!.factId, unversioned!.factId].toSorted(),
        );
        assert.strictEqual((yield* memory.lookupFacts(blog, {})).length, 1);
        assert.strictEqual(
          (yield* memory.lookupFacts(shop, { environment: "https://staging.shop.test" })).length,
          1,
        );
        yield* memory.putFact(
          shop,
          fact({
            kind: "data",
            route: "/",
            key: "Tested app version",
            value: "1.3",
            appVersion: "1.3",
            author: "user",
          }),
        );
        const inherited = yield* memory.putFact(
          shop,
          fact({ key: "observed after version change" }),
        );
        assert.strictEqual(inherited!.appVersion, "1.3");
        const refreshed = yield* memory.putFact(shop, fact({ appVersion: "1.3" }));
        assert.strictEqual(refreshed!.status, "current");
        const history = yield* memory.listFacts(shop, 100);
        assert.strictEqual(
          history.find((row) => row.factId === first!.factId)?.supersededBy,
          refreshed!.factId,
        );
        yield* memory.deleteFact(shop, refreshed!.factId);
        assert.strictEqual(
          (yield* memory.lookupFacts(shop, {
            environment: "https://shop.test",
            key: "empty email",
          })).length,
          0,
        );
        assert.strictEqual(
          (yield* memory.lookupFacts(shop, { key: "empty email", status: "stale" })).length,
          1,
        );
      }),
    ),
  );

  it.effect("accepts evidence only when it exists in this project's run", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const run = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login" },
        ]);
        const ref = { threadId, runId: run.runId, scenarioIndex: 0 } as const;
        const put = (projectId: ProjectId, evidence: ProjectMemoryFactInput["evidence"]) =>
          memory.putFact(projectId, fact({ evidence })).pipe(Effect.exit);

        assert.isTrue(Exit.isSuccess(yield* put(shop, [{ ...ref, type: "screenshot" }])));
        assert.isTrue(
          Exit.isSuccess(yield* put(shop, [{ ...ref, type: "console", entryIndex: 0 }])),
        );
        for (const missing of [
          [{ ...ref, type: "console", entryIndex: 1 }],
          [{ ...ref, scenarioIndex: 1, type: "screenshot" }],
          [{ ...ref, runId: "20260101T000000Z-aaaaaa", type: "network" }],
        ] as const) {
          assert.isTrue(Exit.isFailure(yield* put(shop, missing)));
        }
        assert.isTrue(Exit.isFailure(yield* put(blog, [{ ...ref, type: "screenshot" }])));
      }),
    ),
  );

  it.effect("saves an agent's observation only for the site under test, citing this run", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const qaRuns = yield* QaRuns.QaRuns;
        yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login page", verdict: "PASS", note: "Seen" },
          page("https://shop.test/login"),
        );
        yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Followed a link", verdict: "PASS", note: "Seen" },
          page("https://evil.test/"),
        );
        const run = (yield* qaRuns.openRun(threadId))!;
        const observe = (pageUrl: string, scenarioIndex = 0) =>
          memory
            .putObservedFact(shop, run, {
              pageUrl,
              scenarioIndex,
              kind: "validation",
              key: "empty email",
              value: "Email is required",
            })
            .pipe(Effect.exit);

        const saved = yield* observe("https://shop.test/login?next=1");
        assert.isTrue(Exit.isSuccess(saved));
        assert.deepInclude(Exit.isSuccess(saved) ? saved.value : null, {
          environment: "https://shop.test",
          route: "/login",
          author: "agent",
          evidence: [{ threadId, runId: run.runId, scenarioIndex: 0, type: "screenshot" }],
        });
        // A page a link led to is not the project's, even with this run's evidence.
        assert.isTrue(Exit.isFailure(yield* observe("https://evil.test/", 1)));
        assert.isTrue(Exit.isFailure(yield* observe("https://shop.test/login", 5)));
        const otherThread = yield* finishedRun(
          shop,
          [{ scenario: "Admin", verdict: "PASS", url: "https://admin.shop.test/" }],
          ThreadId.make("thread-memory-other"),
        );
        // A site the project already has facts for is one of its sites.
        assert.isTrue(Exit.isSuccess(yield* observe("https://admin.shop.test/users")));
        assert.equal(otherThread.projectId, shop);
      }),
    ),
  );

  it.effect("keeps each project's memory to itself", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        yield* memory.putFact(shop, fact());
        yield* memory.putFact(blog, fact({ value: "Blog email is required" }));
        assert.deepStrictEqual(
          (yield* memory.lookupFacts(blog, {})).map((row) => row.value),
          ["Blog email is required"],
        );
        const [shopFact] = yield* memory.lookupFacts(shop, {});
        yield* memory.deleteFact(blog, shopFact!.factId);
        assert.strictEqual((yield* memory.lookupFacts(shop, {})).length, 1);
      }),
    ),
  );

  it.effect("deletes a run's facts with the run, and the earlier result is current again", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const qaRuns = yield* QaRuns.QaRuns;
        const scenario = { scenario: "Login works", url: "https://shop.test/login" };
        yield* finishedRun(shop, [{ ...scenario, verdict: "PASS" }]);
        const second = yield* finishedRun(shop, [{ ...scenario, verdict: "FAIL" }]);
        assert.deepStrictEqual(
          (yield* memory.lookupFacts(shop, { kind: "result" })).map((row) => row.value),
          ["FAIL major"],
        );

        yield* qaRuns.deleteRun({ threadId, runId: second.runId });
        const facts = yield* memory.lookupFacts(shop, { kind: "result" });
        assert.deepStrictEqual(
          facts.map((row) => [row.value, row.supersededBy]),
          [["PASS", null]],
        );
        assert.deepStrictEqual(yield* memory.lookupFacts(shop, { status: "superseded" }), []);
        assert.isFalse(facts[0]!.evidence.some((ref) => ref.runId === second.runId));
      }),
    ),
  );

  it.effect("forgets a deleted project's memory and leaves other projects alone", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const saved = yield* memory.putFact(shop, fact());
        yield* memory.putFact(blog, fact());
        yield* memory.deleteFact(shop, saved!.factId);
        yield* memory.putFact(shop, fact({ key: "empty password" }));
        yield* memory.forgetProject(shop);
        assert.deepStrictEqual(yield* memory.listFacts(shop, 10), []);
        assert.notStrictEqual(yield* memory.putFact(shop, fact()), null);
        assert.strictEqual((yield* memory.listFacts(blog, 10)).length, 1);
      }),
    ),
  );

  it.effect("never brings a deleted fact back", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const written = yield* memory.putFact(shop, fact());
        yield* memory.deleteFact(shop, written!.factId);
        assert.isNull(yield* memory.putFact(shop, fact()));
        assert.deepStrictEqual(yield* memory.lookupFacts(shop, {}), []);
        assert.isNotNull(yield* memory.putFact(shop, fact({ value: "Please enter an email" })));
      }),
    ),
  );

  it.effect("redacts credentials before storing a fact", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const written = yield* memory.putFact(
          shop,
          fact({
            kind: "api",
            key: "login request",
            value: "401 with Authorization: Bearer abc.def",
            detail: "Sent cookie: sid=123",
            pageUrl: "https://user:pw@shop.test/login?token=secret",
          }),
        );
        const [stored] = yield* memory.lookupFacts(shop, { kind: "api" });
        assert.deepStrictEqual(stored, written);
        assert.notInclude(JSON.stringify(stored), "abc.def");
        assert.notInclude(JSON.stringify(stored), "sid=123");
        assert.strictEqual(stored?.pageUrl, "https://shop.test/login?token=REDACTED");

        // Passwords the user typed in chat, in run results and in an agent's observation.
        const secrets = ["secret_sauce"];
        const qaRuns = yield* QaRuns.QaRuns;
        yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login as demo / secret_sauce", verdict: "PASS", note: "Seen" },
          page("https://shop.test/login"),
        );
        const run = (yield* qaRuns.finishRun(threadId, { projectId: shop, secrets }))!;
        yield* memory.putObservedFact(
          shop,
          run,
          {
            pageUrl: "https://shop.test/login",
            scenarioIndex: 0,
            kind: "rule",
            key: "demo login",
            value: "demo signs in with secret_sauce",
            detail: "password secret_sauce",
          },
          secrets,
        );
        const saved = JSON.stringify(yield* memory.lookupFacts(shop, { limit: 50 }));
        assert.notInclude(saved, "secret_sauce");
        assert.include(saved, "demo signs in with <provided password>");
        assert.include(saved, "Login as demo / <provided password>");
      }),
    ),
  );
});

it.each([
  ["https://shop.test/orders/4812?tab=items#top", "/orders/:id"],
  ["/users/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f/settings/", "/users/:id/settings"],
  ["https://shop.test/", "/"],
  ["/blog/how-to-shop-better", "/blog/how-to-shop-better"],
  ["/files/a1b2c3d4e5f6a7b8", "/files/:id"],
])("normalizes %s to the route %s", (input, route) => {
  assert.strictEqual(memoryRoute(input), route);
});
