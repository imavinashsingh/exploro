import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  TextGenerationError,
  ThreadId,
  type ProjectUnderstandingExtraction,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MemoryEmbedder from "./MemoryEmbedder.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectMemoryControl from "./ProjectMemoryControl.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as UnderstandingExtraction from "./UnderstandingExtraction.ts";

const shop = ProjectId.make("shop");
const blog = ProjectId.make("blog");
const threadId = ThreadId.make("thread-understanding-1");
const site = "https://shop.test";

// Concepts stand in for meaning: texts sharing a concept are close, with or without shared words.
const CONCEPTS = [/sign|login|session|auth/i, /pay|checkout|card|order/i, /search|filter/i];
const conceptEmbedder = Layer.succeed(
  MemoryEmbedder.MemoryEmbedder,
  MemoryEmbedder.MemoryEmbedder.of({
    status: Effect.succeed({ model: "concepts", unavailableReason: null }),
    embed: Effect.fn("TestEmbedder.embed")((texts: ReadonlyArray<string>) =>
      Effect.succeed(
        texts.map((text) => {
          const vector = Float32Array.from(CONCEPTS, (concept) => (concept.test(text) ? 1 : 0));
          const length = Math.hypot(...vector) || 1;
          return vector.map((value) => value / length);
        }),
      ),
    ),
  }),
);

type Generate = TextGeneration.TextGeneration["Service"]["generateProjectUnderstanding"];
const noItems: Generate = () => Effect.succeed({ items: [], replacedFacts: [] });

let randomSeed = 0;
const withUnderstanding = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | QaRuns.QaRuns
    | ProjectMemory.ProjectMemory
    | ProjectMemoryControl.ProjectMemoryControl
    | ProjectUnderstanding.ProjectUnderstanding
    | UnderstandingExtraction.UnderstandingExtraction
    | FileSystem.FileSystem
  >,
  options: {
    readonly active?: boolean;
    readonly scratch?: boolean;
    readonly memoryOff?: boolean;
    readonly embedder?: Layer.Layer<MemoryEmbedder.MemoryEmbedder>;
    readonly generate?: Generate;
    readonly userMessages?: ReadonlyArray<
      string | { readonly text: string; readonly creationSource: string }
    >;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "exploro-understanding-" });
    const records = {
      thread: { projectId: shop, deletedAt: null },
      runs: options.active ? [{ status: "running" }] : [],
      runtimeRequests: [],
      messages: (options.userMessages ?? []).map((message) =>
        typeof message === "string"
          ? { text: message, streaming: false, creationSource: "web" }
          : { ...message, streaming: false },
      ),
    };
    return yield* body.pipe(
      Effect.provide(
        ProjectMemoryControl.layer.pipe(
          Layer.provideMerge(UnderstandingExtraction.layer),
          Layer.provideMerge(QaRuns.layer),
          Layer.provideMerge(
            ProjectMemory.layer.pipe(Layer.provideMerge(ProjectUnderstanding.layer)),
          ),
          Layer.provideMerge(options.embedder ?? MemoryEmbedder.layerUnavailable),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(TextGeneration.TextGeneration)({
                generateProjectUnderstanding: options.generate ?? noItems,
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                // Only the fields extraction reads.
                getThreadRecords: () => Effect.succeed(records as never),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.succeedSome({ title: "Shop", workspaceRoot: baseDir } as never),
              }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                isScratchProject: () => Effect.succeed(options.scratch ?? false),
              }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  projectSettingsOverrides: { [shop]: { qaMemoryEnabled: !options.memoryOff } },
                }),
              }),
            ),
          ),
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

/** A finished run in `projectId` whose scenarios become evidence-backed result facts. */
const finishedRun = (
  projectId: ProjectId,
  scenarios: ReadonlyArray<{
    scenario: string;
    verdict: "PASS" | "FAIL";
    path: string;
    origin?: string;
  }>,
) =>
  Effect.gen(function* () {
    const qaRuns = yield* QaRuns.QaRuns;
    for (const { scenario, verdict, path, origin = site } of scenarios) {
      yield* qaRuns.recordEvidence(
        threadId,
        { scenario, verdict, note: `${scenario}: ${verdict}` },
        {
          url: `${origin}${path}`,
          title: "Page",
          png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
        },
      );
    }
    const run = (yield* qaRuns.finishRun(threadId, { projectId }))!;
    const facts = yield* (yield* ProjectMemory.ProjectMemory).lookupFacts(projectId, {
      runId: run.runId,
    });
    return { run, facts };
  });

const write = (
  overrides: Partial<ProjectUnderstanding.UnderstandingWrite> = {},
): ProjectUnderstanding.UnderstandingWrite => ({
  ref: "new-1",
  itemId: null,
  kind: "dependency",
  statement: "The dashboard needs a signed-in session",
  citedFactIds: [],
  dependsOn: [],
  author: "agent",
  ...overrides,
});

it.layer(NodeServices.layer)("ProjectUnderstanding", (it) => {
  it.effect.each([{ active: true }, { scratch: true }, { memoryOff: true }])(
    "refuses to save an unavailable thread: %j",
    (options) =>
      withUnderstanding(
        Effect.gen(function* () {
          const control = yield* ProjectMemoryControl.ProjectMemoryControl;
          const runs = yield* QaRuns.QaRuns;
          assert.isTrue(Exit.isFailure(yield* Effect.exit(control.saveThread(threadId))));
          assert.deepStrictEqual(yield* runs.list(threadId), []);
        }),
        options,
      ),
  );

  it.effect("saves a stopped thread once and queues learning without exposing its password", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const control = yield* ProjectMemoryControl.ProjectMemoryControl;
        const memory = yield* ProjectMemory.ProjectMemory;
        const runs = yield* QaRuns.QaRuns;
        const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
        yield* runs.recordEvidence(
          threadId,
          { scenario: "Login", verdict: "PASS", note: "password s3cret_pw" },
          {
            url: site,
            title: "Shop",
            png: new Uint8Array([1]),
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
          },
        );
        yield* control.saveThread(threadId);
        const run = (yield* runs.list(threadId))[0]!;
        assert.strictEqual(run.projectId, shop);
        const facts = yield* memory.lookupFacts(shop, { runId: run.runId });
        assert.strictEqual(facts.length, 1);
        assert.isFalse(facts[0]!.detail!.includes("s3cret_pw"));
        yield* extraction.extract(run.runId);
        yield* control.saveThread(threadId);
        assert.strictEqual((yield* extraction.status(shop)).pendingExtractions, 0);
        assert.strictEqual((yield* memory.listFacts(shop, 100)).length, 1);
      }),
      { userMessages: ["The password is s3cret_pw."] },
    ),
  );

  it.effect("verifies agent items only on current evidence from the tested environment", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        const memory = yield* ProjectMemory.ProjectMemory;
        const qaRuns = yield* QaRuns.QaRuns;
        const { run, facts } = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", path: "/login" },
        ]);
        const userFact = yield* memory.putFact(shop, {
          environment: site,
          route: "/",
          kind: "rule",
          key: "dashboard",
          value: "Needs a session",
          evidence: [],
          author: "user",
        });
        const cited = [facts[0]!.factId];
        const status = (
          overrides: Partial<ProjectUnderstanding.UnderstandingWrite>,
          environment = site,
        ) =>
          understanding
            .saveItems(shop, [write(overrides)], { environment })
            .pipe(Effect.map((items) => items[0]?.status));

        assert.strictEqual(yield* status({ citedFactIds: cited }), "verified");
        assert.strictEqual(
          yield* status({ citedFactIds: cited }, "https://staging.shop.test"),
          "hypothesis",
        );
        assert.strictEqual(yield* status({ citedFactIds: [userFact!.factId] }), "hypothesis");
        assert.strictEqual(
          yield* status({ citedFactIds: [...cited, userFact!.factId] }),
          "verified",
        );
        assert.strictEqual(yield* status({ citedFactIds: ["missing"] }), "hypothesis");
        assert.strictEqual(yield* status({}), "hypothesis");
        assert.isTrue(
          Exit.isFailure(
            yield* understanding
              .saveItems(shop, [write({ confirm: true })], { environment: site })
              .pipe(Effect.exit),
          ),
        );

        const [verified] = yield* understanding.saveItems(
          shop,
          [write({ statement: "Login lands on the dashboard", citedFactIds: cited })],
          { environment: site },
        );
        yield* qaRuns.deleteRun({ threadId, runId: run.runId });
        const [after] = yield* understanding.getItems(shop, [verified!.itemId]);
        assert.strictEqual(after?.status, "hypothesis");
        assert.isTrue(after?.needsReview);
      }),
    ),
  );

  it.effect("keeps every version and never lets an agent revise a confirmed item", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        const context = { environment: site };
        const [created] = yield* understanding.saveItems(shop, [write()], context);
        const itemId = created!.itemId;
        const revise = (overrides: Partial<ProjectUnderstanding.UnderstandingWrite>) =>
          understanding.saveItems(shop, [write({ ref: itemId, itemId, ...overrides })], context);

        assert.deepStrictEqual(yield* revise({}), []);
        yield* revise({ statement: "The dashboard needs a session cookie" });
        yield* revise({
          statement: "The dashboard needs a session cookie",
          author: "user",
          confirm: true,
        });
        assert.deepStrictEqual(yield* revise({ statement: "Agent rewrite" }), []);

        const history = yield* understanding.history(shop, itemId);
        assert.deepStrictEqual(
          history.map((version) => [version.version, version.status, version.statement]),
          [
            [1, "hypothesis", "The dashboard needs a signed-in session"],
            [2, "hypothesis", "The dashboard needs a session cookie"],
            [3, "confirmed", "The dashboard needs a session cookie"],
          ],
        );
        assert.deepStrictEqual(yield* understanding.history(blog, itemId), []);
      }),
    ),
  );

  it.effect("deletes an item for good, unlinking what depended on it", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        const context = { environment: site };
        const [session, dashboard] = yield* understanding.saveItems(
          shop,
          [
            write({ statement: "Sign in first" }),
            write({
              ref: "new-2",
              kind: "workflow",
              statement: "Open the dashboard",
              dependsOn: ["new-1"],
            }),
          ],
          context,
        );
        yield* understanding.deleteItem(blog, session!.itemId);
        assert.lengthOf(yield* understanding.getItems(shop, [session!.itemId]), 1);

        yield* understanding.deleteItem(shop, session!.itemId);
        assert.deepStrictEqual(yield* understanding.getItems(shop, [session!.itemId]), []);
        assert.deepStrictEqual(yield* understanding.history(shop, session!.itemId), []);
        const [left] = yield* understanding.getItems(shop, [dashboard!.itemId]);
        assert.deepStrictEqual(left?.dependsOn, []);
        assert.deepStrictEqual((yield* understanding.recall(shop, "sign in")).items, []);

        assert.deepStrictEqual(
          yield* understanding.saveItems(
            shop,
            [write({ statement: "  sign in   FIRST" })],
            context,
          ),
          [],
        );
        const [mine] = yield* understanding.saveItems(
          shop,
          [write({ statement: "Sign in first", author: "user" })],
          context,
        );
        assert.strictEqual(mine?.statement, "Sign in first");
      }),
    ),
  );

  it.effect("recalls by text when no model is loaded, following depends-on links", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
        const [, , dashboard] = yield* understanding.saveItems(
          shop,
          [
            write({
              ref: "login",
              kind: "workflow",
              statement: "Sign in with the seeded admin account",
            }),
            write({
              ref: "session",
              statement: "A session cookie is set after sign in",
              dependsOn: ["login"],
            }),
            write({
              ref: "dashboard",
              kind: "workflow",
              statement: "Open the dashboard from the top menu",
              dependsOn: ["session"],
            }),
            write({
              ref: "search",
              kind: "lesson",
              statement: "Search results load after typing stops",
            }),
          ],
          { environment: site },
        );
        yield* understanding.saveItems(blog, [write({ statement: "Dashboard shows blog posts" })], {
          environment: site,
        });

        const recall = yield* understanding.recall(shop, "Test the dashboard!");
        assert.strictEqual(recall.mode, "text");
        assert.deepStrictEqual(
          recall.items.map(({ item, via }) => [item.statement, via]),
          [
            ["Open the dashboard from the top menu", "match"],
            ["A session cookie is set after sign in", "dependency"],
            ["Sign in with the seeded admin account", "dependency"],
          ],
        );
        assert.strictEqual(recall.items[0]?.item.itemId, dashboard?.itemId);
        assert.strictEqual((yield* extraction.status(shop)).recall, "text");
      }),
    ),
  );

  it.effect("ranks items by meaning and words together when a model is loaded", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        yield* understanding.saveItems(
          shop,
          [
            write({ ref: "a", statement: "Checkout needs a saved card" }),
            write({ ref: "b", statement: "Filters reset when the page reloads" }),
          ],
          { environment: site },
        );
        const recall = yield* understanding.recall(shop, "test the payment flow");
        assert.strictEqual(recall.mode, "semantic");
        assert.strictEqual(recall.items[0]?.item.statement, "Checkout needs a saved card");
      }),
      { embedder: conceptEmbedder },
    ),
  );

  it.effect("embeds items saved before a model was loaded when recall first needs them", () => {
    let loaded = false;
    const lateEmbedder = Layer.effect(
      MemoryEmbedder.MemoryEmbedder,
      Effect.map(Layer.build(conceptEmbedder), (context) => {
        const concepts = Context.get(context, MemoryEmbedder.MemoryEmbedder);
        return MemoryEmbedder.MemoryEmbedder.of({
          status: Effect.suspend(() =>
            loaded ? concepts.status : Effect.succeed({ model: null, unavailableReason: "off" }),
          ),
          embed: (texts) => (loaded ? concepts.embed(texts) : Effect.succeed(null)),
        });
      }),
    );
    return withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        yield* understanding.saveItems(
          shop,
          [write({ ref: "a", statement: "Checkout needs a saved card" })],
          { environment: site },
        );
        loaded = true;
        const recall = yield* understanding.recall(shop, "test the payment flow");
        assert.deepStrictEqual(
          recall.items.map(({ item }) => item.statement),
          ["Checkout needs a saved card"],
        );
      }),
      { embedder: lateEmbedder },
    );
  });

  it.effect("extracts items after a run, citing facts and only verbatim user quotes", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        const memory = yield* ProjectMemory.ProjectMemory;
        const { run } = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", path: "/login" },
          // A link left the site under test; its fact is newer but must not set the environment.
          { scenario: "Help opens", verdict: "PASS", path: "/help", origin: "https://help.test" },
        ]);
        yield* extraction.enqueue(run);
        yield* extraction.extract(run.runId);

        const items = yield* understanding.getItems(shop);
        assert.deepStrictEqual(
          items.map((item) => [item.statement, item.status, item.author]).toSorted(),
          [
            ["Admins sign in with <provided password>", "hypothesis", "agent"],
            ["Admins skip checkout", "hypothesis", "agent"],
            ["Coupons only apply at checkout", "hypothesis", "agent"],
            ["Login lands on the dashboard", "verified", "agent"],
            ["Retest the cart after coupons", "hypothesis", "agent"],
          ],
        );
        const rules = yield* memory.lookupFacts(shop, { kind: "rule" });
        assert.deepStrictEqual(
          rules.map((fact) => [fact.value, fact.author]),
          [["Coupons only apply at checkout.", "user"]],
        );
        assert.deepStrictEqual((yield* extraction.status(shop)).failedExtractions, []);
      }),
      {
        userMessages: [
          "Coupons only apply at checkout. Please retest the cart.",
          "Sign in as admin, the password is s3cret_pw.",
          // An answer to the agent's question carries the question's text, which the user never wrote.
          { text: "Admins skip checkout. May I test as admin?\nYes", creationSource: "server" },
        ],
        generate: (input) => {
          // The model never sees a password the user gave, so it cannot learn it.
          if (input.prompt.includes("s3cret_pw")) return Effect.die("the prompt has the password");
          const factId =
            /\[([^\]]+)\] result https:\/\/shop\.test\/login/.exec(input.prompt)?.[1] ?? "";
          const output: ProjectUnderstandingExtraction = {
            items: [
              {
                ref: "new-1",
                kind: "workflow",
                statement: "Login lands on the dashboard",
                citedFactIds: [factId],
                dependsOn: [],
                userQuote: null,
              },
              {
                ref: "new-2",
                kind: "lesson",
                statement: "Coupons only apply at checkout",
                citedFactIds: [],
                dependsOn: [],
                userQuote: "Coupons only apply at checkout.",
              },
              {
                ref: "new-3",
                kind: "lesson",
                statement: "Admins skip checkout",
                citedFactIds: [],
                dependsOn: [],
                userQuote: "Admins skip checkout.",
              },
              {
                ref: "new-5",
                kind: "lesson",
                statement: "Retest the cart after coupons",
                citedFactIds: [],
                dependsOn: [],
                userQuote: "Coupons only apply at checkout. Please retest the cart.",
              },
              {
                ref: "new-6",
                kind: "lesson",
                statement: "Admins sign in with s3cret_pw",
                citedFactIds: [],
                dependsOn: [],
                userQuote: null,
              },
              {
                ref: "new-4",
                kind: "advice",
                statement: "Test empty inputs",
                citedFactIds: [],
                dependsOn: [],
                userQuote: null,
              },
            ],
            replacedFacts: [],
          };
          return Effect.succeed(output);
        },
      },
    ),
  );

  it.effect(
    "replaces an earlier fact that a run restates in other words, until that run goes",
    () =>
      withUnderstanding(
        Effect.gen(function* () {
          const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
          const memory = yield* ProjectMemory.ProjectMemory;
          const first = yield* finishedRun(shop, [
            { scenario: "Locked out user is rejected", verdict: "PASS", path: "/login" },
          ]);
          const second = yield* finishedRun(shop, [
            { scenario: "locked_out_user cannot sign in", verdict: "FAIL", path: "/login" },
          ]);
          yield* extraction.enqueue(second.run);
          yield* extraction.extract(second.run.runId);
          const current = () =>
            memory
              .lookupFacts(shop, { kind: "result" })
              .pipe(Effect.map((facts) => facts.map((fact) => [fact.key, fact.supersededBy])));
          assert.deepStrictEqual(yield* current(), [["locked_out_user cannot sign in", null]]);
          assert.strictEqual(
            (yield* memory.lookupFacts(shop, { status: "superseded" }))[0]?.supersededBy,
            second.facts[0]?.factId,
          );

          const rule = yield* memory.putFact(shop, {
            environment: site,
            route: "/login",
            kind: "result",
            key: "Locked out users must be refused",
            value: "PASS",
            evidence: [],
            author: "user",
          });
          assert.strictEqual(
            yield* memory.supersedeFacts(shop, [
              { factId: rule!.factId, byFactId: second.facts[0]!.factId },
              { factId: second.facts[0]!.factId, byFactId: first.facts[0]!.factId },
            ]),
            0,
          );

          yield* memory.forgetRun(second.run.runId);
          assert.deepStrictEqual((yield* current()).toSorted(), [
            ["Locked out user is rejected", null],
            ["Locked out users must be refused", null],
          ]);
        }),
        {
          generate: (input) => {
            const id = (key: string) =>
              new RegExp(`\\[([^\\]]+)\\] result \\S+ "${key}"`).exec(input.prompt)?.[1] ?? "";
            const earlier = id("Locked out user is rejected");
            const latest = id("locked_out_user cannot sign in");
            return Effect.succeed({
              items: [],
              replacedFacts: [
                { factId: earlier, byFactId: latest },
                // Not an earlier fact the model was shown.
                { factId: latest, byFactId: latest },
              ],
            });
          },
        },
      ),
  );

  it.effect("records a failed extraction without touching the run, and retries it", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
        const qaRuns = yield* QaRuns.QaRuns;
        const { run } = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", path: "/login" },
        ]);
        yield* extraction.enqueue(run);
        yield* extraction.extract(run.runId);
        const failed = yield* extraction.status(shop);
        assert.deepStrictEqual(
          failed.failedExtractions.map((entry) => entry.runId),
          [run.runId],
        );
        assert.isNotNull((yield* qaRuns.list(threadId))[0]?.reportMarkdownPath);

        yield* extraction.retry(shop, run.runId);
        assert.strictEqual((yield* extraction.status(shop)).pendingExtractions, 1);
        yield* extraction.retry(blog, run.runId);
      }),
      {
        generate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateProjectUnderstanding",
              detail: "offline",
            }),
          ),
      },
    ),
  );
});
