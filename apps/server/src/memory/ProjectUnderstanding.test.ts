import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  TextGenerationError,
  ThreadId,
  QaSuiteId,
  type ProjectUnderstandingExtraction,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MarkdownMemoryStore from "./MarkdownMemoryStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectMemoryControl from "./ProjectMemoryControl.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as UnderstandingExtraction from "./UnderstandingExtraction.ts";
import * as QaRecorder from "../qa/QaRecorder.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

const shop = ProjectId.make("shop");
const blog = ProjectId.make("blog");
const threadId = ThreadId.make("thread-understanding-1");
const site = "https://shop.test";

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
    | QaRecorder.QaRecorder
    | MarkdownMemoryStore.MarkdownMemoryStore
    | SqlClient.SqlClient
    | FileSystem.FileSystem
  >,
  options: {
    readonly active?: boolean;
    readonly scratch?: boolean;
    readonly memoryOff?: boolean;
    readonly runStatus?: "completed" | "interrupted" | "failed";
    /** How the running turn ends: its status commits only after the turn-end signal. */
    readonly turnEndsAs?: "completed" | "interrupted";
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
      runs:
        options.active || options.turnEndsAs
          ? [{ status: "running" }]
          : options.runStatus
            ? [{ status: options.runStatus }]
            : [],
      runtimeRequests: [],
      messages: (options.userMessages ?? []).map((message) =>
        typeof message === "string"
          ? { text: message, streaming: false, creationSource: "web" }
          : { ...message, streaming: false },
      ),
    };
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const project of [shop, blog]) {
        for (const environment of [site, "https://staging.shop.test", "https://help.test"]) {
          for (const path of [
            "/",
            "/login",
            "/dashboard",
            "/checkout",
            "/cart",
            "/search",
            "/help",
          ]) {
            const id = environment + path;
            yield* sql`INSERT INTO project_navigation_states (project_id, state_id, data) VALUES (${project}, ${id}, ${JSON.stringify({ id, name: path, environment, path, aliases: [], context: {}, checks: [] })})`;
          }
        }
      }
      return yield* body;
    }).pipe(
      Effect.provide(
        ProjectMemoryControl.layer.pipe(
          Layer.provideMerge(QaRecorder.layer),
          Layer.provide(PreviewAgentActivity.layer),
          Layer.provideMerge(UnderstandingExtraction.layer),
          Layer.provideMerge(MarkdownMemoryStore.layer.pipe(Layer.provide(NodeCrypto.layer))),
          Layer.provideMerge(QaRuns.layer),
          Layer.provideMerge(
            ProjectMemory.layer.pipe(Layer.provideMerge(ProjectUnderstanding.layer)),
          ),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(TextGeneration.TextGeneration)({
                generateProjectUnderstanding: options.generate ?? noItems,
              }),
              Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () => Effect.succeed({ projectId: shop } as never),
                // Only the fields extraction reads.
                getThreadRecords: () => Effect.succeed(records as never),
                waitForThread: () =>
                  Effect.succeed({
                    threadId,
                    run: { status: options.turnEndsAs ?? records.runs.at(-1)?.status } as never,
                    timedOut: false,
                  }),
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
                  projectSettingsOverrides: {
                    [shop]: { qaMemoryEnabled: !options.memoryOff, qaSiteOrigins: [site] },
                  },
                }),
              }),
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

/** A finished run in `projectId` whose scenarios become evidence-backed result facts. */
const finishedRun = (
  projectId: ProjectId,
  scenarios: ReadonlyArray<{
    scenario: string;
    verdict: "PASS" | "FAIL";
    path: string;
    origin?: string;
  }>,
  thread = threadId,
) =>
  Effect.gen(function* () {
    const qaRuns = yield* QaRuns.QaRuns;
    for (const { scenario, verdict, path, origin = site } of scenarios) {
      yield* qaRuns.recordEvidence(
        thread,
        { scenario, verdict, note: `${scenario}: ${verdict}` },
        {
          stateId: `${origin}${path}`,
          url: `${origin}${path}`,
          title: "Page",
          png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
        },
      );
    }
    const run = (yield* qaRuns.finishRun(thread, { projectId }))!;
    const facts = yield* (yield* ProjectMemory.ProjectMemory).lookupFacts(projectId, {
      runId: run.runId,
    });
    for (const fact of facts) {
      yield* (yield* ProjectMemory.ProjectMemory).putFact(projectId, {
        stateId: fact.stateId,
        kind: "validation",
        key: fact.key,
        value: `Observed screen behavior: ${fact.key}`,
        evidence: fact.evidence,
        author: "agent",
      });
    }
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
  it.effect.each(["completed", "interrupted", "failed"] as const)(
    "remembers only completed turns automatically: %s",
    (runStatus) =>
      withUnderstanding(
        Effect.gen(function* () {
          const runs = yield* QaRuns.QaRuns;
          const memory = yield* ProjectMemory.ProjectMemory;
          yield* runs.recordEvidence(
            threadId,
            { scenario: "Login", verdict: "PASS", note: "Observed" },
            {
              stateId: site + "/login",
              url: site + "/login",
              title: "Login",
              png: new Uint8Array([1]),
              consoleEntries: [],
              networkEntries: [],
              actionTimeline: [],
            },
          );
          const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
          const docs = yield* MarkdownMemoryStore.MarkdownMemoryStore;
          const run = yield* (yield* QaRecorder.QaRecorder).finish(threadId);
          assert.strictEqual(run?.remember, runStatus === "completed");
          assert.strictEqual(
            (yield* memory.lookupFacts(shop, { kind: "result" })).length,
            runStatus === "completed" ? 1 : 0,
          );
          yield* extraction.extract(run!.runId);
          // An interrupted run the user did not save queues no proposals either.
          assert.strictEqual(
            (yield* docs.listProposals(shop)).length,
            runStatus === "completed" ? 1 : 0,
          );
          if (runStatus !== "completed") {
            yield* (yield* ProjectMemoryControl.ProjectMemoryControl).saveThread(threadId);
            assert.strictEqual((yield* memory.lookupFacts(shop, { kind: "result" })).length, 1);
            yield* extraction.extract(run!.runId);
            assert.strictEqual((yield* docs.listProposals(shop)).length, 1);
          }
        }),
        { runStatus, userMessages: ["Test login", "Use the EUR store"] },
      ),
  );
  it.effect.each(["completed", "interrupted"] as const)(
    "remembers a run qa_report_finish closed mid-turn once the turn ends: %s",
    (endStatus) =>
      withUnderstanding(
        Effect.gen(function* () {
          const qaRuns = yield* QaRuns.QaRuns;
          const memory = yield* ProjectMemory.ProjectMemory;
          const recorder = yield* QaRecorder.QaRecorder;
          yield* qaRuns.recordEvidence(
            threadId,
            { scenario: "Login", verdict: "PASS", note: "Observed" },
            {
              stateId: site + "/login",
              url: site + "/login",
              title: "Login",
              png: new Uint8Array([1]),
              consoleEntries: [],
              networkEntries: [],
              actionTimeline: [],
            },
          );
          const closed = yield* recorder.finish(threadId, "exploratory", { midTurn: true });
          assert.strictEqual(closed?.finishedAt === null, false);
          assert.strictEqual((yield* memory.lookupFacts(shop, { kind: "result" })).length, 0);
          // As in the app, the turn-end signal arrives while the turn still reads as running.
          yield* recorder.finish(threadId);
          const saved = (yield* qaRuns.list(threadId)).find((run) => run.runId === closed!.runId);
          assert.strictEqual(saved?.remember, endStatus === "completed");
          assert.strictEqual(
            (yield* memory.lookupFacts(shop, { kind: "result" })).length,
            endStatus === "completed" ? 1 : 0,
          );
        }),
        { turnEndsAs: endStatus, userMessages: ["Test login"] },
      ),
  );
  it.effect("brings confirmed legacy understanding into the playbook from the Memory screen", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO project_memory_understanding (item_id, project_id, kind, statement, status, author, created_at, updated_at) VALUES ('legacy-1', ${shop}, 'workflow', 'Use the EUR store', 'confirmed', 'user', '2026-11-23', '2026-11-23')`;
        const snapshot = yield* (yield* ProjectMemoryControl.ProjectMemoryControl).snapshot(shop);
        assert.deepStrictEqual(
          snapshot.docs?.map((doc) => [doc.kind, doc.body]),
          [["playbook", "- Use the EUR store"]],
        );
      }),
    ),
  );
  it.effect(
    "proposes reviewable drafts from steers and setup flows, never FAIL results or secrets",
    () =>
      withUnderstanding(
        Effect.gen(function* () {
          const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
          const docs = yield* MarkdownMemoryStore.MarkdownMemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const { run } = yield* finishedRun(shop, [
            { scenario: "Pay button does nothing", verdict: "FAIL", path: "/checkout" },
          ]);
          const steps = [
            ["/login", "/dashboard", "Sign in"],
            ["/dashboard", "/checkout", "Open checkout"],
          ] as const;
          for (const [index, [from, to, action]] of steps.entries()) {
            const edge = {
              id: `edge-${index}`,
              from: site + from,
              to: site + to,
              action,
              conditions: {},
              runId: run.runId,
              threadId,
              observedAt: "2026-11-24T00:00:00Z",
              available: true,
            };
            yield* sql`INSERT INTO project_navigation_observations
              (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at)
              VALUES (${`obs-${index}`}, ${shop}, ${threadId}, ${run.runId}, 'tab', ${site + to}, ${index}, ${JSON.stringify(edge)}, '2026-11-24')`;
          }
          yield* extraction.enqueue(run);
          yield* extraction.extract(run.runId);
          const proposals = yield* docs.listProposals(shop);
          assert.deepStrictEqual(
            proposals.map((proposal) => [proposal.targetDocId, proposal.status]).toSorted(),
            [
              ["shop:guide:reach-checkout", "pending"],
              ["shop:playbook:playbook", "pending"],
            ],
          );
          const text = JSON.stringify(proposals);
          assert.include(text, "Coupons need a signed-in cart");
          assert.include(text, "Open checkout");
          for (const leaked of ["abc123def456", "s3cret_pw", "Pay button does nothing"])
            assert.notInclude(text, leaked);
          // Nothing becomes memory until the user approves it.
          assert.deepStrictEqual(yield* docs.listDocs(shop), []);
        }),
        {
          userMessages: [
            "Test checkout",
            "The password is s3cret_pw.",
            "Coupons need a signed-in cart; api_key=abc123def456",
          ],
        },
      ),
  );
  it.effect(
    "lists, dismisses and approves proposals, and guards confirmed documents in the snapshot",
    () =>
      withUnderstanding(
        Effect.gen(function* () {
          const control = yield* ProjectMemoryControl.ProjectMemoryControl;
          const docs = yield* MarkdownMemoryStore.MarkdownMemoryStore;
          yield* finishedRun(shop, [
            { scenario: "Pay button does nothing", verdict: "FAIL", path: "/checkout" },
          ]);
          const draft = (slug: string, body: string) => ({
            kind: "guide" as const,
            slug,
            title: `Reach ${slug}`,
            summary: "",
            environment: site,
            routes: [`/${slug}`],
            body,
            rationale: "Seen in a run",
          });
          yield* docs.proposeDocs(shop, "run-a", [
            draft("cart", "Add an item first.\n"),
            draft("orders", "Open the menu.\n"),
          ]);
          const before = yield* control.snapshot(shop);
          assert.deepStrictEqual(
            before.proposals?.map((proposal) => proposal.targetDocId).toSorted(),
            ["shop:guide:cart", "shop:guide:orders"],
          );
          // FAIL results are open issues, apart from the playbook and guides.
          assert.deepStrictEqual(
            before.openIssues?.map((fact) => fact.key),
            ["Pay button does nothing"],
          );
          assert.deepStrictEqual(before.docs, []);

          const [cart, orders] = before.proposals!.toSorted((a, b) =>
            a.targetDocId.localeCompare(b.targetDocId),
          );
          const dismissed = yield* control.dismissProposal({
            projectId: shop,
            proposalId: orders!.proposalId,
          });
          assert.strictEqual(dismissed.status, "dismissed");
          const approved = yield* control.approveProposal({
            projectId: shop,
            proposalId: cart!.proposalId,
          });
          assert.strictEqual(approved.status, "approved");
          const after = yield* control.snapshot(shop);
          assert.deepStrictEqual(after.proposals, []);
          // Dismissing wrote no file; approving wrote a confirmed, searchable guide.
          assert.deepStrictEqual(
            after.docs?.map((doc) => [doc.slug, doc.status]),
            [["cart", "confirmed"]],
          );
          assert.deepStrictEqual(
            (yield* docs.searchDocs(shop, "item")).map((doc) => doc.slug),
            ["cart"],
          );
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                control.approveProposal({ projectId: shop, proposalId: cart!.proposalId }),
              ),
            ),
          );

          const saved = yield* control.saveDoc({
            projectId: shop,
            kind: "playbook",
            slug: "playbook",
            title: "Project playbook",
            summary: "",
            routes: [],
            keywords: [],
            body: "Use the EUR store.\n",
          });
          assert.strictEqual(saved.status, "confirmed");
          const [steer] = yield* docs.proposeDocs(shop, "run-b", [
            {
              kind: "playbook",
              slug: "playbook",
              title: "Project playbook",
              summary: "",
              environment: null,
              routes: [],
              body: "- Coupons need a signed-in cart\n",
              rationale: "Steered",
            },
          ]);
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                control.approveProposal({ projectId: shop, proposalId: steer!.proposalId }),
              ),
            ),
          );
          const playbook = (yield* control.snapshot(shop)).docs?.find(
            (doc) => doc.kind === "playbook",
          );
          assert.strictEqual(playbook?.body, "Use the EUR store.\n");
          yield* control.approveProposal({
            projectId: shop,
            proposalId: steer!.proposalId,
            replaceConfirmed: true,
          });
          const merged = (yield* control.snapshot(shop)).docs?.find(
            (doc) => doc.kind === "playbook",
          );
          assert.include(merged?.body, "Use the EUR store.");
          assert.include(merged?.body, "Coupons need a signed-in cart");
        }),
      ),
  );
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
            stateId: site + "/",
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
          stateId: site + "/login",
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

  it.effect("uses FTS5 for save and recall", () =>
    withUnderstanding(
      Effect.gen(function* () {
        const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
        yield* understanding.saveItems(
          shop,
          [write({ statement: "Checkout needs a saved card" })],
          { environment: site },
        );
        const recall = yield* understanding.recall(shop, "checkout");
        assert.strictEqual(recall.mode, "text");
        assert.strictEqual(recall.items[0]?.item.statement, "Checkout needs a saved card");
      }),
    ),
  );

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
            ["Sign in as qa@shop.test", "hypothesis", "agent"],
          ],
        );
        // Accounts and instructions come only from the user's own words, and are not repeated as facts.
        assert.deepStrictEqual(
          (yield* understanding.contextItems(shop)).map((item) => [item.kind, item.statement]),
          [["account", "Sign in as qa@shop.test"]],
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
          "Use qa@shop.test as the test account.",
          // An answer to the agent's question carries the question's text, which the user never wrote.
          { text: "Admins skip checkout. May I test as admin?\nYes", creationSource: "server" },
        ],
        generate: (input) => {
          // The model never sees a password the user gave, so it cannot learn it.
          if (input.prompt.includes("s3cret_pw")) return Effect.die("the prompt has the password");
          const factId =
            /\[([^\]]+)\] validation .* https:\/\/shop\.test\/login/.exec(input.prompt)?.[1] ?? "";
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
                ref: "new-7",
                kind: "account",
                statement: "Sign in as qa@shop.test",
                citedFactIds: [],
                dependsOn: [],
                userQuote: "Use qa@shop.test as the test account.",
              },
              {
                ref: "new-8",
                kind: "account",
                statement: "Sign in as owner@help.test",
                citedFactIds: [],
                dependsOn: [],
                userQuote: null,
              },
              {
                ref: "new-9",
                kind: "instruction",
                statement: "Always test as admin",
                citedFactIds: [],
                dependsOn: [],
                userQuote: "Admins skip checkout.",
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
    "excludes regression and remember-false runs from extraction and explicit regression saves",
    () =>
      withUnderstanding(
        Effect.gen(function* () {
          const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
          const control = yield* ProjectMemoryControl.ProjectMemoryControl;
          const runs = yield* QaRuns.QaRuns;
          yield* runs.startRegressionRun(threadId, {
            suiteId: QaSuiteId.make("suite"),
            site,
            dataRow: null,
          });
          const run = (yield* (yield* QaRecorder.QaRecorder).finish(threadId, "regression"))!;
          assert.strictEqual(run.remember, false);
          for (const excluded of [run, { ...run, kind: "exploratory" as const, remember: false }]) {
            yield* extraction.enqueue(excluded);
            assert.strictEqual((yield* extraction.status(shop)).pendingExtractions, 0);
          }
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(runs.rememberRun(threadId, run.runId, shop))),
          );
          yield* control.saveThread(threadId);
          assert.strictEqual((yield* extraction.status(shop)).pendingExtractions, 0);
        }),
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

  it.effect("learns again when a follow-up turn finishes the same run", () => {
    const prompts: Array<string> = [];
    return withUnderstanding(
      Effect.gen(function* () {
        const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;
        const first = yield* finishedRun(shop, [
          { scenario: "Login works", verdict: "PASS", path: "/login" },
        ]);
        yield* extraction.enqueue(first.run);
        yield* extraction.extract(first.run.runId);
        yield* TestClock.adjust("1 minute");
        // One thread is one run: the follow-up turn reopens and finishes it again.
        const second = yield* finishedRun(shop, [
          { scenario: "Checkout opens", verdict: "PASS", path: "/checkout" },
        ]);
        assert.strictEqual(second.run.runId, first.run.runId);
        yield* extraction.enqueue(second.run);
        yield* extraction.extract(second.run.runId);
        assert.strictEqual(prompts.length, 2);
        assert.include(prompts[1], "Checkout opens");
      }),
      {
        generate: (input) => {
          prompts.push(input.prompt);
          return noItems(input);
        },
      },
    );
  });
});
