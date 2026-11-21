// @effect-diagnostics nodeBuiltinImport:off -- The benchmark owns disposable server homes and reports host measurements.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as Net from "@t3tools/shared/Net";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  DEFAULT_BROWSER_PROFILE_ID,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Server from "../../apps/server/src/server.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import * as ServerStartup from "../../apps/server/src/serverRuntimeStartup.ts";
import * as ServerEnvironment from "../../apps/server/src/environment/ServerEnvironment.ts";
import * as Settings from "../../apps/server/src/serverSettings.ts";
import * as Broker from "../../apps/server/src/mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../../apps/server/src/mcp/McpInvocationContext.ts";
import * as Launch from "../../apps/server/src/orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as Folders from "../../apps/server/src/project/ManagedProjectFolders.ts";
import { modeSettings, type NavigationDriver, type NavigationTrialResult } from "./benchmark.ts";
import { navigationCases, navigationOrigin } from "./cases.ts";

class BenchmarkError extends Schema.TaggedError<BenchmarkError>()("NavigationBenchmarkError", {
  message: Schema.String,
}) {}

// Reads headings through a read-only snapshot: the agent owns its tab, so the harness may not evaluate there.
const visibleHeadings = (tree: unknown): string[] =>
  typeof tree === "string"
    ? [...tree.matchAll(/^\s*- heading "((?:[^"\\]|\\.)*)"/gmu)].map((match) =>
        match[1]!.replace(/\\(.)/gu, "$1").trim(),
      )
    : [];
const root = NodePath.resolve(import.meta.dirname, "../..");
export type NavigationProvider = "claudeAgent" | "codex";
// The user's own MCP servers (such as a real-browser bridge) must not reach benchmark agents.
// Codex merges its config with T3's per-thread servers: plugin, app, and browser features are
// switched off first, then every MCP server still enabled. Plugin servers cannot be disabled by name.
const codexIsolatedFeatures = [
  "plugins",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
];
const isolatedProvider = (provider: NavigationProvider) => {
  const features = codexIsolatedFeatures.flatMap((feature) => ["--disable", feature]);
  const servers =
    provider === "codex"
      ? (
          JSON.parse(
            NodeChildProcess.execFileSync("codex", [...features, "mcp", "list", "--json"], {
              encoding: "utf8",
            }),
          ) as Array<{ name: string; enabled: boolean }>
        )
          .filter((server) => server.enabled)
          .map((server) => server.name)
      : [];
  return {
    disabledServers: servers,
    settings: {
      providerInstances: {
        [provider]: {
          driver: ProviderDriverKind.make(provider),
          config: {
            launchArgs:
              provider === "codex"
                ? [
                    ...features,
                    ...servers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
                  ].join(" ")
                : "--strict-mcp-config",
          },
        },
      },
    },
  };
};
const uuid = SecureRandom.SecureRandom.pipe(Effect.flatMap((random) => random.uuidV4()));
const withHost = <A, E, R>(home: string, program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provide(
      Layer.merge(Server.layerServer, Broker.layer).pipe(
        Layer.provide(
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              return { ...config, noBrowser: true, startupPresentation: "headless" as const };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(root, home))),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Net.layer),
      ),
    ),
    Effect.scoped,
  );

const openThread = Effect.fn("navigationBenchmark.openThread")(function* (
  projectId: ProjectId,
  model: string,
  provider: NavigationProvider = "claudeAgent",
) {
  const instance = ProviderInstanceId.make(provider);
  yield* (yield* ServerStartup.ServerRuntimeStartup).awaitCommandReady;
  const launch = yield* Launch.ThreadLaunchService;
  const launched = yield* launch.launch({
    commandId: CommandId.make(yield* uuid),
    projectId,
    title: "Navigation benchmark",
    modelSelection: { instanceId: instance, model },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    createdBy: "user",
    creationSource: "server",
  });
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const scope: McpThreadInvocationScope = {
    environmentId: yield* environment.getEnvironmentId,
    requestNamespace: "navigation-benchmark",
    thread: {
      threadId: launched.threadId,
      providerInstanceId: instance,
      providerSessionId: "navigation-benchmark",
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 0,
  };
  return { scope, threadId: launched.threadId };
});

const preparePage = Effect.fn("navigationBenchmark.preparePage")(function* (
  scope: McpThreadInvocationScope,
  start: string,
  keepOpen = false,
) {
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.logInfo("Navigation benchmark: opening built-in browser");
  const opened = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: {
        url: `${navigationOrigin}/web/index.php/auth/logout`,
        profileId: DEFAULT_BROWSER_PROFILE_ID,
        reuseExistingTab: false,
        show: false,
      },
    })
    .pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced("2 seconds"),
        while: (error) =>
          error._tag === "PreviewAutomationExecutionError" &&
          error.reason?.startsWith("T3 is installing its headless browser") === true,
      }),
    );
  if (opened.tabId === null)
    return yield* new BenchmarkError({ message: "No benchmark tab was opened." });
  const tabId = opened.tabId;
  const invoke = <A = unknown>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
  ) => broker.invoke<A>({ scope, tabId, operation, input });
  yield* invoke("waitFor", { text: "Login", timeoutMs: 15000 });
  const login = yield* invoke<PreviewAutomationSnapshot>("snapshot", { pixelsRequired: false });
  const username = /Username\s*:\s*(\S+)/u.exec(login.visibleText)?.[1];
  const password = /Password\s*:\s*(\S+)/u.exec(login.visibleText)?.[1];
  if (!username || !password)
    return yield* new BenchmarkError({ message: "The demo did not advertise its credentials." });
  if (start !== "signed-out") {
    yield* invoke("type", { locator: 'input[name="username"]', text: username });
    yield* invoke("type", { locator: 'input[name="password"]', text: password });
    yield* invoke("click", { locator: 'button[type="submit"]' });
    yield* invoke("waitFor", { text: "Dashboard", timeoutMs: 15000 });
    const startScreen = navigationCases.find((item) => item.path === start);
    if (startScreen !== undefined) {
      yield* invoke("navigate", { url: `${navigationOrigin}/web/index.php${start}` });
      yield* invoke("waitFor", { text: startScreen.heading, timeoutMs: 15000 });
    }
  }
  const prepared = yield* invoke<PreviewAutomationSnapshot>("snapshot", { pixelsRequired: false });
  // An open tab keeps the profile's session cookies alive; a blank one leaves the agent nothing to act on.
  const parked = keepOpen
    ? (yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { profileId: DEFAULT_BROWSER_PROFILE_ID, reuseExistingTab: false, show: false },
      })).tabId
    : null;
  yield* invoke("close", {});
  const version = /OrangeHRM(?: OS)?\s+([0-9]+(?:\.[0-9]+)+)/u.exec(login.visibleText)?.[1];
  if (version === undefined)
    return yield* new BenchmarkError({ message: "The demo version could not be verified." });
  return {
    url: prepared.url,
    username,
    password,
    version,
    close:
      parked === null
        ? Effect.void
        : broker
            .invoke({ scope, tabId: parked, operation: "close", input: {} })
            .pipe(Effect.ignore),
  };
});

const agentTurn = Effect.fn("navigationBenchmark.agentTurn")(function* (
  projectId: ProjectId,
  threadId: ThreadId,
  model: string,
  message: string,
  timeoutMs: number,
  provider: NavigationProvider,
) {
  const instance = ProviderInstanceId.make(provider);
  const threads = yield* Threads.ThreadManagementService;
  yield* Effect.logInfo("Navigation benchmark: starting pinned model", { model });
  const sent = yield* threads.sendToThread({
    projectId,
    threadId,
    commandId: CommandId.make(yield* uuid),
    messageId: MessageId.make(yield* uuid),
    text: message,
    attachments: [],
    modelSelection: { instanceId: instance, model },
    mode: "auto",
    createdBy: "user",
    creationSource: "server",
  });
  const result = yield* threads.waitForThread({
    projectId,
    threadId,
    runId: sent.run.id,
    timeoutMs,
  });
  if (result.timedOut)
    yield* threads.interruptThread({
      projectId,
      threadId,
      runId: sent.run.id,
      commandId: CommandId.make(yield* uuid),
      reason: "Navigation benchmark deadline",
    });
  yield* Effect.logInfo("Navigation benchmark: turn stopped", {
    timedOut: result.timedOut,
    status: result.run?.status,
  });
  return {
    result,
    records: yield* threads.getThreadRecords(threadId, [
      "providerTurns",
      "providerSessions",
      "runs",
    ]),
  };
});

export const runTrial: NavigationDriver["runTrial"] = async (input) => {
  const manifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(input.seedDirectory, "manifest.json"), "utf8"),
  ) as {
    projectId: string;
    version: string;
    preparationTokens: number | null;
    preparationMs: number;
    provider?: NavigationProvider;
  };
  const provider = manifest.provider ?? "claudeAgent";
  const home = NodePath.join(input.seedDirectory, "home");
  return Effect.runPromise(
    withHost(
      home,
      Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* (yield* ServerStartup.ServerRuntimeStartup).awaitCommandReady;
        const project = yield* (yield* Folders.ManagedProjectFolders).createNamedProject({
          name: `Navigation trial ${input.trial.id}`,
        });
        const projectId = project.projectId;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const table of [
              "project_memory_facts",
              "project_memory_understanding",
              "project_memory_deleted",
              "project_navigation_states",
              "project_navigation_observations",
              "project_navigation_feedback",
            ]) {
              yield* sql`UPDATE ${sql(table)} SET project_id = ${projectId} WHERE project_id = ${manifest.projectId}`;
            }
          }),
        );
        yield* settings.updateSettings({
          ...isolatedProvider(provider).settings,
          projectSettingsOverrides: { [projectId]: modeSettings(input.trial.mode) },
        });
        const { scope, threadId } = yield* openThread(projectId, input.model, provider);
        const prepared = yield* preparePage(scope, input.task.start, true);
        const started = performance.now();
        const { result, records } = yield* agentTurn(
          projectId,
          threadId,
          input.model,
          `Open ${prepared.url} in browser profile ${DEFAULT_BROWSER_PROFILE_ID}. ${input.task.goal}. Stop when the destination is visible. Do not edit records or submit forms. Use at most ${input.actionBudget} browser actions. ` +
            (input.task.start === "signed-out"
              ? ""
              : "The browser profile should already be signed in; the shared demo sometimes ends sessions. ") +
            `If the site asks you to sign in, use this demo account: username ${prepared.username}, password ${prepared.password}. ` +
            (input.task.clicksOnly
              ? "This site cannot open its screens by address: after opening the start page, move only by clicking controls on the page, and never open or navigate to another address. "
              : "") +
            "Use Project Navigation Memory if enabled, and record newly observed navigation. Report blockers honestly.",
          180_000,
          provider,
        );
        const elapsedMs = performance.now() - started;
        const broker = yield* Broker.PreviewAutomationBroker;
        const session = records.providerSessions.at(-1);
        if (session === undefined)
          return yield* new BenchmarkError({ message: "The provider session never started." });
        const agentScope = { ...scope, thread: { ...scope.thread, providerSessionId: session.id } };
        // No tab of the agent's own means it never arrived; that is an outcome, not a host failure.
        const page = yield* broker
          .invoke<PreviewAutomationSnapshot>({
            scope: agentScope,
            operation: "snapshot",
            input: { pixelsRequired: false },
          })
          .pipe(
            Effect.catchTags({ PreviewAutomationTabNotFoundError: () => Effect.succeed(null) }),
          );
        yield* prepared.close;
        const usage = records.providerTurns.map((turn) => turn.turnTokenUsage);
        const complete =
          usage.length > 0 && usage.every((value) => value?.usageStatus === "complete");
        const inputTokens = complete
          ? usage.reduce((sum, value) => sum + (value?.inputTokens ?? 0), 0)
          : null;
        const outputTokens = complete
          ? usage.reduce((sum, value) => sum + (value?.outputTokens ?? 0), 0)
          : null;
        const primitive = (page?.actionTimeline ?? []).filter(
          (action) => !["snapshot", "evaluate", "check", "status"].includes(action.action),
        );
        return {
          outcome:
            result.timedOut || primitive.length > input.actionBudget
              ? "budget-exhausted"
              : result.run?.status === "completed"
                ? "finished"
                : "blocked",
          elapsedMs,
          primitiveActions: primitive.length,
          failedActions: primitive.filter((action) => action.error !== undefined).length,
          inputTokens,
          outputTokens,
          cachedInputTokens: complete
            ? usage.reduce((sum, value) => sum + (value?.cachedInputTokens ?? 0), 0)
            : null,
          preparationTokens: manifest.preparationTokens,
          preparationMs: manifest.preparationMs,
          observation:
            page === null
              ? null
              : {
                  url: page.url,
                  headings: visibleHeadings(page.accessibilityTree),
                  source: "live-browser",
                },
          appVersion: prepared.version,
          threadId,
          model: input.model,
        } satisfies NavigationTrialResult;
      }),
    ),
  );
};

export const pilot: NavigationDriver["pilot"] = async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "exploro-navigation-pilot-"));
  return Effect.runPromise(
    withHost(
      home,
      Effect.gen(function* () {
        yield* Effect.logInfo("Navigation benchmark: awaiting ready host");
        yield* (yield* ServerStartup.ServerRuntimeStartup).awaitCommandReady;
        yield* Effect.logInfo("Navigation benchmark: creating isolated project");
        const project = yield* (yield* Folders.ManagedProjectFolders).createNamedProject({
          name: "Navigation pilot",
        });
        const { scope } = yield* openThread(project.projectId, "claude-haiku-5-5");
        const broker = yield* Broker.PreviewAutomationBroker;
        const supportedCases: string[] = [];
        const unsupportedCases: Array<{ id: string; reason: string }> = [];
        let version = "";
        for (const item of navigationCases) {
          const outcome = yield* Effect.result(
            Effect.gen(function* () {
              const prepared = yield* preparePage(scope, item.start);
              if (version && version !== prepared.version)
                return yield* new BenchmarkError({
                  message: "The website version changed during the pilot.",
                });
              version = prepared.version;
              const opened = yield* broker.invoke<PreviewAutomationStatus>({
                scope,
                operation: "open",
                input: {
                  url: prepared.url,
                  profileId: DEFAULT_BROWSER_PROFILE_ID,
                  reuseExistingTab: false,
                  show: false,
                },
              });
              if (opened.tabId === null)
                return yield* new BenchmarkError({ message: "The pilot tab did not open." });
              const tabId = opened.tabId;
              if (item.start === "signed-out") {
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "type",
                  input: { locator: 'input[name="username"]', text: prepared.username },
                });
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "type",
                  input: { locator: 'input[name="password"]', text: prepared.password },
                });
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "click",
                  input: { locator: 'button[type="submit"]' },
                });
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "waitFor",
                  input: { text: "Dashboard", timeoutMs: 15000 },
                });
              }
              let target = `${navigationOrigin}/web/index.php${item.path}`;
              // Paths ending in "/" belong to one employee record; the demo user's number completes them.
              if (item.path.startsWith("/pim/") && item.path.endsWith("/")) {
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "navigate",
                  input: { url: `${navigationOrigin}/web/index.php/pim/viewMyDetails` },
                });
                yield* broker.invoke({
                  scope,
                  tabId,
                  operation: "waitFor",
                  input: { text: "Personal Details", timeoutMs: 15000 },
                });
                const personal = yield* broker.invoke<PreviewAutomationSnapshot>({
                  scope,
                  tabId,
                  operation: "snapshot",
                  input: { pixelsRequired: false },
                });
                const employee = /empNumber\/([0-9]+)/u.exec(personal.url)?.[1];
                if (employee === undefined)
                  return yield* new BenchmarkError({
                    message: "The demo account has no employee profile.",
                  });
                target += `empNumber/${employee}`;
              }
              yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: target } });
              yield* broker
                .invoke({
                  scope,
                  tabId,
                  operation: "waitFor",
                  input: { text: item.heading, timeoutMs: 15000 },
                })
                .pipe(Effect.ignore);
              const observed = yield* broker.invoke<PreviewAutomationSnapshot>({
                scope,
                tabId,
                operation: "snapshot",
                input: { pixelsRequired: false },
              });
              const url = new URL(observed.url);
              if (
                url.origin !== navigationOrigin ||
                !url.pathname.includes(item.path) ||
                !visibleHeadings(observed.accessibilityTree).includes(item.heading)
              )
                return yield* new BenchmarkError({
                  message: `Independent arrival checks did not match the destination (saw ${url.pathname} with headings ${visibleHeadings(observed.accessibilityTree).join(" | ")}).`,
                });
              yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
            }),
          );
          if (outcome._tag === "Success") supportedCases.push(item.id);
          else unsupportedCases.push({ id: item.id, reason: String(outcome.failure) });
        }
        if (!version)
          return yield* new BenchmarkError({
            message: "No website version was verified; the pilot cannot proceed.",
          });
        return { version, supportedCases, unsupportedCases };
      }),
    ),
  );
};

export async function prepareSeed(
  directory: string,
  model: string,
  provider: NavigationProvider = "claudeAgent",
) {
  const isolation = isolatedProvider(provider);
  // The learner gets the same goals as trial agents; a bare title gives no hint where a screen lives.
  const destinations = [...new Map(navigationCases.map((item) => [item.path, item.goal])).values()];
  const home = NodePath.join(directory, "home");
  await NodeFSP.mkdir(home, { recursive: true });
  const started = performance.now();
  const manifest = await Effect.runPromise(
    withHost(
      home,
      Effect.gen(function* () {
        yield* Effect.logInfo("Navigation benchmark: awaiting ready host");
        yield* (yield* ServerStartup.ServerRuntimeStartup).awaitCommandReady;
        yield* Effect.logInfo("Navigation benchmark: creating isolated project");
        const project = yield* (yield* Folders.ManagedProjectFolders).createNamedProject({
          name: "Navigation learning",
        });
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          ...isolation.settings,
          projectSettingsOverrides: {
            [project.projectId]: { qaMemoryEnabled: true },
          },
        });
        const { scope, threadId } = yield* openThread(project.projectId, model, provider);
        const prepared = yield* preparePage(scope, "signed-out");
        const learned = yield* agentTurn(
          project.projectId,
          threadId,
          model,
          `Explore navigation on ${navigationOrigin}, using browser profile ${DEFAULT_BROWSER_PROFILE_ID}. Demo username ${prepared.username}, password ${prepared.password}. ` +
            `Learn how to reach every screen in this checklist:\n${destinations.map((goal, index) => `${index + 1}. ${goal}`).join("\n")}\n` +
            "Memory starts empty, so expect no routes: explore each one live and keep going until every item is reached. " +
            "Observe Login, then sign in and observe Dashboard. From Dashboard, reach each target and return to Dashboard between targets, observing the return as well. " +
            "Use navigation_observe for every screen and connection. Use a consistent screen name and the same distinctive heading check each time. " +
            "Use context authenticated=false on Login and authenticated=true after login; omit unverified roles and personal values. " +
            "Observe each destination after the action that reached it. Capture useful facts with evidence. Do not edit records or submit forms.",
          600_000,
          provider,
        );
        if (learned.result.timedOut || learned.result.run?.status !== "completed")
          return yield* new BenchmarkError({
            message: "The learning run did not complete; do not benchmark this seed.",
          });

        const usage = learned.records.providerTurns.map((turn) => turn.turnTokenUsage);
        return {
          projectId: project.projectId,
          version: prepared.version,
          model,
          provider,
          disabledMcpServers: isolation.disabledServers,
          disabledFeatures: provider === "codex" ? codexIsolatedFeatures : [],
          preparationTokens:
            usage.length && usage.every((value) => value?.usageStatus === "complete")
              ? usage.reduce(
                  (sum, value) => sum + (value?.inputTokens ?? 0) + (value?.outputTokens ?? 0),
                  0,
                )
              : null,
          preparationThreadId: threadId,
        };
      }),
    ),
  );
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  let facts = 0;
  let transitions = 0;
  let uncovered: string[] = [];
  try {
    facts = Number(
      database
        .prepare("SELECT COUNT(*) AS n FROM project_memory_facts WHERE project_id = ?")
        .get(manifest.projectId)?.n ?? 0,
    );
    transitions = Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM project_navigation_observations WHERE project_id = ? AND transition_json IS NOT NULL",
        )
        .get(manifest.projectId)?.n ?? 0,
    );
    // Routing needs an observed connection into each benchmark destination.
    const ends = database
      .prepare(
        `SELECT json_extract(s.data, '$.path') AS path FROM project_navigation_observations o
        JOIN project_navigation_states s ON s.project_id = o.project_id
          AND s.state_id = json_extract(o.transition_json, '$.to')
        WHERE o.project_id = ? AND o.transition_json IS NOT NULL`,
      )
      .all(manifest.projectId)
      .map((row) => String(row.path));
    uncovered = [...new Set(navigationCases.map((item) => item.path))].filter(
      (path) => !ends.some((end) => end.includes(path)),
    );
  } finally {
    database.close();
  }
  if (!facts || !transitions || uncovered.length > 0)
    throw new Error(
      `The learning seed must contain facts, observed connections, and a connection into every destination before the comparison (missing: ${uncovered.join(", ") || "none"}).`,
    );
  await NodeFSP.writeFile(
    NodePath.join(directory, "manifest.json"),
    JSON.stringify(
      { ...manifest, facts, transitions, preparationMs: performance.now() - started },
      null,
      2,
    ),
    { flag: "wx" },
  );
}
