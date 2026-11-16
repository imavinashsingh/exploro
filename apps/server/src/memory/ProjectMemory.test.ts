import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, type ProjectMemoryFactInput } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

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
  body: Effect.Effect<A, E, QaRuns.QaRuns | ProjectMemory.ProjectMemory | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "exploro-memory-" });
    return yield* body.pipe(
      Effect.provide(
        QaRuns.layer.pipe(
          Layer.provideMerge(ProjectMemory.layer),
          Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
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
  scenarios: ReadonlyArray<{ scenario: string; verdict: "PASS" | "FAIL"; url: string }>,
  thread = threadId,
) =>
  Effect.gen(function* () {
    const qaRuns = yield* QaRuns.QaRuns;
    for (const { scenario, verdict, url } of scenarios) {
      yield* qaRuns.recordEvidence(
        thread,
        {
          scenario,
          verdict,
          note: `${scenario}: ${verdict}`,
          severity: verdict === "FAIL" ? "major" : undefined,
        },
        page(url),
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
  it.effect("writes a result fact per scenario when a project's run finishes", () =>
    withMemory(
      Effect.gen(function* () {
        const memory = yield* ProjectMemory.ProjectMemory;
        const run = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", url: "https://shop.test/login?next=/" },
          { scenario: "Order opens", verdict: "FAIL", url: "https://shop.test/orders/4812" },
        ]);
        const facts = yield* memory.lookupFacts(shop, { kind: "result" });
        assert.deepStrictEqual(
          facts.map((row) => [row.route, row.key, row.value, row.author]).toSorted(),
          [
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
