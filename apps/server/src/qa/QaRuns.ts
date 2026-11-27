import {
  QaRun,
  QaRunError,
  type PreviewAutomationActionEvent,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationNetworkEntry,
  type QaCheck,
  type QaDataRow,
  type QaVisualResult,
  type QaEvidenceRecordInput,
  QaReplayStep,
  type QaRunDeleteInput,
  type QaRunDeleteResult,
  type QaRunsSnapshot,
  type ProjectId,
  type QaScenario,
  type QaSuiteId,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import {
  QA_MAX_SCENARIOS_PER_RUN,
  QA_MAX_SCREENSHOT_BYTES,
  qaThreadFolder,
  resolveVerdict,
  sanitizeConsoleEntries,
  sanitizeNetworkEntries,
  scenarioFileStem,
  stepsFor,
  summarizeLogs,
} from "./qaEvidence.ts";
import * as QaFolders from "./QaFolders.ts";
import { QA_VIDEO_FILE, renderHtmlReport, renderMarkdownReport } from "./qaReport.ts";

/** A replay's comparison with the scenario's baseline, saved beside its other evidence. */
export interface QaReplayVisual {
  readonly baseline: Uint8Array;
  readonly capture: Uint8Array;
  readonly diffPng: Uint8Array | null;
  readonly diffRatio: number | null;
  readonly threshold: number;
}

/** What the browser showed when the agent recorded a verdict. */
export interface QaPageCapture {
  readonly url: string | null;
  readonly title: string | null;
  readonly png: Uint8Array | null;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: ReadonlyArray<PreviewAutomationActionEvent>;
}

export class QaRuns extends Context.Service<
  QaRuns,
  {
    /** The thread's unfinished run, started now if it has none. */
    readonly ensureRun: (
      threadId: ThreadId,
      input: { readonly site: string | null },
    ) => Effect.Effect<QaRun, QaRunError>;
    readonly openRun: (threadId: ThreadId) => Effect.Effect<QaRun | null, QaRunError>;
    readonly recordEvidence: (
      threadId: ThreadId,
      input: QaEvidenceRecordInput,
      page: QaPageCapture,
      checks?: ReadonlyArray<QaCheck>,
    ) => Effect.Effect<QaScenario, QaRunError>;
    /** Adds one replayable browser step to the thread's exploratory run. */
    readonly appendStep: (
      threadId: ThreadId,
      step: QaReplayStep,
    ) => Effect.Effect<void, QaRunError>;
    readonly readSteps: (run: QaRun) => Effect.Effect<ReadonlyArray<QaReplayStep>, QaRunError>;
    /** Opens a run that replays a suite; fails while the thread has another run open. */
    readonly startRegressionRun: (
      threadId: ThreadId,
      input: {
        readonly suiteId: QaSuiteId;
        readonly site: string | null;
        readonly dataRow: QaDataRow | null;
      },
    ) => Effect.Effect<QaRun, QaRunError>;
    /** Records a replayed scenario's verdict in the open regression run. */
    readonly recordReplayedScenario: (
      threadId: ThreadId,
      input: QaEvidenceRecordInput,
      page: QaPageCapture,
      replay: {
        readonly checks: ReadonlyArray<QaCheck>;
        readonly stepCount: number;
        readonly visual?: QaReplayVisual | undefined;
      },
    ) => Effect.Effect<QaScenario, QaRunError>;
    readonly markRecordingStarted: (
      threadId: ThreadId,
      startedAt: string,
    ) => Effect.Effect<void, QaRunError>;
    /** Moves a finished recording into the open run's evidence folder. */
    readonly attachVideo: (
      threadId: ThreadId,
      input: { readonly sourcePath: string; readonly sizeBytes: number },
    ) => Effect.Effect<void, QaRunError>;
    readonly markVideoUnavailable: (
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, QaRunError>;
    /** Writes both reports and closes the open run; null when there is none. */
    readonly finishRun: (
      threadId: ThreadId,
      input: {
        readonly projectId: ProjectId | null;
        /** Only an open run of this kind finishes. Default exploratory. */
        readonly kind?: QaRun["kind"];
      },
    ) => Effect.Effect<QaRun | null, QaRunError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<QaRun>, QaRunError>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<QaRunsSnapshot, QaRunError>;
    readonly deleteRun: (input: QaRunDeleteInput) => Effect.Effect<QaRunDeleteResult, QaRunError>;
  }
>()("t3/qa/QaRuns") {}

const RunJson = Schema.fromJsonString(QaRun);
const STEPS_FILE = "steps.jsonl";
const decodeStepLine = Schema.decodeUnknownOption(Schema.fromJsonString(QaReplayStep));
const encodeStepLine = Schema.encodeEffect(Schema.fromJsonString(QaReplayStep));
const REPLAY_RUNNING =
  "A regression replay is running in this thread. Wait for it to finish, then test again.";
const decodeRunJson = Schema.decodeUnknownOption(RunJson);
const encodeRunJson = Schema.encodeEffect(RunJson);
const encodeLogJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const failure = (message: string) => (cause: unknown) => new QaRunError({ message, cause });

/**
 * A stored run as found in `dir`. Every file path is rebuilt from that folder, so a moved folder
 * keeps working and an edited `run.json` cannot point anywhere else.
 */
function locateRun(path: Path.Path, run: QaRun, dir: string, projectId: ProjectId | null): QaRun {
  const evidence = (stored: string) => {
    const name = stored.split(/[\\/]/).at(-1) ?? "";
    return path.join(dir, "evidence", name === ".." || name === "." ? "" : name);
  };
  const optional = (stored: string | null) => (stored === null ? null : evidence(stored));
  return {
    ...run,
    projectId: projectId ?? run.projectId,
    dir,
    video: run.video === null ? null : { ...run.video, path: evidence(run.video.path) },
    reportMarkdownPath: run.reportMarkdownPath === null ? null : path.join(dir, "report.md"),
    reportHtmlPath: run.reportHtmlPath === null ? null : path.join(dir, "report.html"),
    scenarios: run.scenarios.map((scenario) => ({
      ...scenario,
      screenshotPath: optional(scenario.screenshotPath),
      consolePath: optional(scenario.consolePath),
      networkPath: optional(scenario.networkPath),
      visual:
        scenario.visual === null
          ? null
          : {
              ...scenario.visual,
              baselinePath: evidence(scenario.visual.baselinePath),
              capturePath: evidence(scenario.visual.capturePath),
              diffPath: optional(scenario.visual.diffPath),
            },
    })),
  };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const folders = yield* QaFolders.QaFolders;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const lock = yield* Semaphore.make(1);
  const cache = new Map<ThreadId, ReadonlyArray<QaRun>>();
  // Steps per open run, counted from its file once, so evidence knows where it falls.
  const stepCounts = new Map<string, number>();

  const qaRunsDir = path.join(config.stateDir, "qa-runs");
  const threadDir = (threadId: ThreadId) => path.join(qaRunsDir, qaThreadFolder(threadId));

  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const platform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Refuses a run file that a link would send outside the run's project or data folder. */
  const guard = (run: Pick<QaRun, "dir">, target: string) =>
    platform(QaFolders.checkInside(QaFolders.baseOf(path, run.dir), target));

  /** The thread's runs stored in `parent`'s subfolders. */
  const readRuns = Effect.fnUntraced(function* (
    parent: string,
    threadId: ThreadId,
    projectId: ProjectId | null,
  ) {
    const names = yield* fileSystem.readDirectory(parent).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as Array<string>),
      ),
    );
    const runs: Array<QaRun> = [];
    // `.partial` is a move still copying.
    for (const name of names.filter((entry) => !entry.endsWith(".partial"))) {
      const dir = path.join(parent, name);
      const manifest = path.join(dir, "run.json");
      const text = yield* guard({ dir }, manifest).pipe(
        Effect.andThen(fileSystem.readFileString(manifest)),
        Effect.orElseSucceed(() => ""),
      );
      const run = decodeRunJson(text);
      if (run._tag === "Some" && run.value.threadId === threadId)
        runs.push(locateRun(path, run.value, dir, projectId));
    }
    return runs;
  });

  const load = Effect.fn("QaRuns.load")(
    function* (threadId: ThreadId) {
      const cached = cache.get(threadId);
      if (cached !== undefined) return cached;
      const project = yield* folders.forThread(threadId);
      const found = [
        ...(project === null
          ? []
          : yield* readRuns(
              path.join(project.root, QaFolders.QA_PROJECT_DIR),
              threadId,
              project.projectId,
            )),
        ...(yield* readRuns(threadDir(threadId), threadId, null)),
      ];
      // A folder copied by hand, or a move cut short, must not list one run twice.
      const runs = [...new Map(found.toReversed().map((run) => [run.runId, run])).values()];
      runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      cache.set(threadId, runs);
      return runs;
    },
    Effect.mapError(failure("Could not read the thread's QA runs.")),
  );

  /** Moves one run out of the data folder into its project; the source goes last. */
  const moveRun = Effect.fnUntraced(function* (source: string) {
    const text = yield* fileSystem
      .readFileString(path.join(source, "run.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodeRunJson(text);
    if (decoded._tag === "None") return;
    const run = decoded.value;
    const ofThread = yield* folders.forThread(run.threadId);
    const project =
      ofThread ?? (run.projectId === null ? null : yield* folders.forProject(run.projectId));
    if (project === null) return;
    const qaRoot = yield* platform(QaFolders.ensureQaRoot(project.root));
    const moved = (yield* readRuns(qaRoot, run.threadId, project.projectId)).find(
      (candidate) => candidate.runId === run.runId,
    );
    if (moved !== undefined) {
      // An earlier move copied it and stopped before removing the source.
      if (yield* platform(QaFolders.isCopyOf(source, moved.dir)))
        return yield* fileSystem.remove(source, { recursive: true });
      return yield* Effect.logWarning("QA run not moved; its project has another copy", { source });
    }
    const name = QaFolders.runFolderName(Date.parse(run.startedAt), ofThread?.threadTitle ?? "");
    const taken = yield* fileSystem.exists(path.join(qaRoot, name));
    const target = path.join(qaRoot, taken ? `${name}_${run.runId.slice(-6)}` : name);
    yield* guard({ dir: target }, target);
    if (yield* fileSystem.exists(target))
      return yield* Effect.logWarning("QA run not moved; the folder is taken", { target });
    yield* platform(QaFolders.copyFolder(source, target));
    yield* fileSystem.remove(source, { recursive: true });
  });

  const migrate = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(qaRunsDir))) return;
    for (const thread of yield* fileSystem.readDirectory(qaRunsDir)) {
      const parent = path.join(qaRunsDir, thread);
      for (const name of yield* fileSystem.readDirectory(parent)) {
        const source = path.join(parent, name);
        yield* moveRun(source).pipe(
          Effect.catch((error) => Effect.logWarning("QA run not moved", { error, source })),
        );
      }
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("QA runs not moved", { error })));
  // Holds the lock from the start, so nothing reads the runs mid-move; startup does not wait.
  yield* lock.withPermit(migrate).pipe(Effect.forkScoped({ startImmediately: true }));

  const save = Effect.fn("QaRuns.save")(
    function* (run: QaRun) {
      yield* guard(run, path.join(run.dir, "run.json"));
      yield* guard(run, path.join(run.dir, "evidence"));
      yield* fileSystem.makeDirectory(path.join(run.dir, "evidence"), { recursive: true });
      yield* platform(
        writeFileStringAtomically({
          filePath: path.join(run.dir, "run.json"),
          contents: `${yield* encodeRunJson(run)}\n`,
        }),
      );
      const runs = yield* load(run.threadId);
      cache.set(run.threadId, [run, ...runs.filter((existing) => existing.runId !== run.runId)]);
      yield* PubSub.publish(changes, run.threadId);
      return run;
    },
    Effect.mapError(failure("Could not save the QA run.")),
  );

  const findOpen = (runs: ReadonlyArray<QaRun>) => runs.find((run) => run.finishedAt === null);

  const ensureRunUnlocked = Effect.fnUntraced(function* (threadId: ThreadId, site: string | null) {
    const open = findOpen(yield* load(threadId));
    if (open?.kind === "regression") return yield* new QaRunError({ message: REPLAY_RUNNING });
    if (open) return open.site === null && site !== null ? yield* save({ ...open, site }) : open;
    // One thread is one test: a follow-up turn continues the run instead of starting another.
    const last = (yield* load(threadId)).find((run) => run.kind === "exploratory");
    if (last) {
      return yield* save({
        ...last,
        site: last.site ?? site,
        finishedAt: null,
        recordingStartedAt: last.video === null ? null : last.recordingStartedAt,
      });
    }
    return yield* createRunUnlocked(threadId, site, {
      kind: "exploratory",
      suiteId: null,
      dataRow: null,
    });
  });

  /** A folder of its own for a new run, in the thread's project when it has one. */
  const claimRunDir = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: string,
    startedAtMillis: number,
  ) {
    const inProject = Effect.gen(function* () {
      const project = yield* folders.forThread(threadId);
      if (project === null) return null;
      const qaRoot = yield* platform(QaFolders.ensureQaRoot(project.root));
      const name = QaFolders.runFolderName(startedAtMillis, project.threadTitle);
      const taken = yield* fileSystem.exists(path.join(qaRoot, name));
      const dir = path.join(qaRoot, taken ? `${name}_${runId.slice(-6)}` : name);
      yield* fileSystem.makeDirectory(dir);
      return dir;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("QA run saved outside its project", { error }).pipe(Effect.as(null)),
      ),
    );
    const dir = yield* inProject;
    if (dir !== null) return dir;
    const fallback = path.join(threadDir(threadId), runId);
    yield* fileSystem
      .makeDirectory(fallback, { recursive: true })
      .pipe(Effect.mapError(failure("Could not create the QA run folder.")));
    return fallback;
  });

  const createRunUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    site: string | null,
    origin: Pick<QaRun, "kind" | "suiteId" | "dataRow">,
  ) {
    const startedAt = yield* nowIso;
    const unique = (yield* random.uuidV4()).slice(0, 6);
    const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${unique}`;
    return yield* save({
      runId,
      threadId,
      ...origin,
      projectId: null,
      site,
      startedAt,
      finishedAt: null,
      dir: yield* claimRunDir(threadId, runId, Date.parse(startedAt)),
      scenarios: [],
      recordingStartedAt: null,
      video: null,
      videoUnavailableReason: null,
      reportMarkdownPath: null,
      reportHtmlPath: null,
    });
  });

  const updateOpenUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    update: (run: QaRun) => QaRun,
  ) {
    const open = findOpen(yield* load(threadId));
    if (open) yield* save(update(open));
  });

  const stepsPath = (run: Pick<QaRun, "dir">) => path.join(run.dir, STEPS_FILE);

  const stepCountOf = Effect.fnUntraced(function* (run: QaRun) {
    const known = stepCounts.get(run.runId);
    if (known !== undefined) return known;
    const count = (yield* readStepsOf(run)).length;
    stepCounts.set(run.runId, count);
    return count;
  });

  const readStepsOf = Effect.fnUntraced(
    function* (run: Pick<QaRun, "dir">) {
      yield* platform(QaFolders.checkInside(QaFolders.baseOf(path, run.dir), stepsPath(run)));
      const text = yield* fileSystem.readFileString(stepsPath(run)).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(""),
        ),
      );
      const steps: Array<QaReplayStep> = [];
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        const step = decodeStepLine(line);
        // A line cut short by a crash would shift every later scenario's steps; keep its place.
        steps.push(
          step._tag === "Some"
            ? step.value
            : { kind: "unreplayable", action: "unknown", reason: "This step could not be read." },
        );
      }
      return steps;
    },
    Effect.mapError(failure("Could not read the run's browser steps.")),
  );

  const appendStepUnlocked = Effect.fnUntraced(
    function* (threadId: ThreadId, step: QaReplayStep) {
      const open = findOpen(yield* load(threadId));
      if (open?.kind === "regression") return;
      const run = open ?? (yield* ensureRunUnlocked(threadId, null));
      const count = yield* stepCountOf(run);
      yield* guard(run, stepsPath(run));
      yield* fileSystem.makeDirectory(run.dir, { recursive: true });
      yield* fileSystem.writeFileString(stepsPath(run), `${yield* encodeStepLine(step)}\n`, {
        flag: "a",
      });
      stepCounts.set(run.runId, count + 1);
    },
    Effect.mapError(failure("Could not save the browser step.")),
  );

  const recordEvidenceUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    input: QaEvidenceRecordInput,
    page: QaPageCapture,
    checks: ReadonlyArray<QaCheck>,
    replayStepCount?: number,
    replayVisual?: QaReplayVisual,
  ) {
    const open = findOpen(yield* load(threadId));
    const replaying = replayStepCount !== undefined;
    if (replaying && open?.kind !== "regression")
      return yield* new QaRunError({ message: "The regression run is no longer open." });
    const run = replaying && open ? open : yield* ensureRunUnlocked(threadId, page.url);
    if (run.scenarios.length >= QA_MAX_SCENARIOS_PER_RUN) {
      return yield* new QaRunError({
        message: `A run holds at most ${QA_MAX_SCENARIOS_PER_RUN} scenarios. Finish this run with qa_report_finish first.`,
      });
    }
    const index = run.scenarios.length;
    const since = run.scenarios.at(-1)?.recordedAt ?? run.startedAt;
    const evidenceDir = path.join(run.dir, "evidence");
    const stem = scenarioFileStem(index, input.scenario);
    const png =
      page.png !== null && page.png.byteLength <= QA_MAX_SCREENSHOT_BYTES ? page.png : null;
    const screenshotPath = png === null ? null : path.join(evidenceDir, `${stem}.png`);
    const consoleEntries = sanitizeConsoleEntries(page.consoleEntries);
    const networkEntries = sanitizeNetworkEntries(page.networkEntries);
    const consolePath = path.join(evidenceDir, `${stem}.console.json`);
    const networkPath = path.join(evidenceDir, `${stem}.network.json`);
    const visualFile = (kind: string) => path.join(evidenceDir, `${stem}.${kind}.png`);
    const visual: QaVisualResult | null =
      replayVisual === undefined
        ? null
        : {
            diffRatio: replayVisual.diffRatio,
            threshold: replayVisual.threshold,
            baselinePath: visualFile("baseline"),
            capturePath: visualFile("capture"),
            diffPath: replayVisual.diffPng === null ? null : visualFile("diff"),
          };
    yield* Effect.gen(function* () {
      for (const target of [
        screenshotPath,
        visual?.baselinePath,
        visual?.capturePath,
        visual?.diffPath,
        consolePath,
        networkPath,
      ]) {
        if (target !== null && target !== undefined) yield* guard(run, target);
      }
      yield* fileSystem.makeDirectory(evidenceDir, { recursive: true });
      if (screenshotPath !== null && png !== null) yield* fileSystem.writeFile(screenshotPath, png);
      if (replayVisual !== undefined && visual !== null) {
        yield* fileSystem.writeFile(visual.baselinePath, replayVisual.baseline);
        yield* fileSystem.writeFile(visual.capturePath, replayVisual.capture);
        if (visual.diffPath !== null && replayVisual.diffPng !== null)
          yield* fileSystem.writeFile(visual.diffPath, replayVisual.diffPng);
      }
      yield* fileSystem.writeFileString(consolePath, yield* encodeLogJson(consoleEntries));
      yield* fileSystem.writeFileString(networkPath, yield* encodeLogJson(networkEntries));
    }).pipe(Effect.mapError(failure("Could not save the scenario's evidence.")));
    const recordedAt = yield* nowIso;
    const { verdict, downgradeReason } = resolveVerdict(input.verdict, screenshotPath !== null);
    const scenario: QaScenario = {
      index,
      scenario: input.scenario,
      verdict,
      ...(downgradeReason === undefined
        ? {}
        : { requestedVerdict: input.verdict, downgradeReason }),
      note: input.note,
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      ...(input.actual === undefined ? {} : { actual: input.actual }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      steps: [...stepsFor(input, page.actionTimeline, since)],
      pageUrl: page.url,
      pageTitle: page.title,
      recordedAt,
      videoOffsetMs:
        run.recordingStartedAt === null
          ? null
          : Math.max(0, Date.parse(recordedAt) - Date.parse(run.recordingStartedAt)),
      screenshotPath,
      consolePath,
      networkPath,
      ...summarizeLogs(consoleEntries, networkEntries, since),
      checks,
      stepCount: replayStepCount ?? (yield* stepCountOf(run)),
      visual,
    };
    yield* save({ ...run, scenarios: [...run.scenarios, scenario] });
    return scenario;
  });

  const attachVideoUnlocked = Effect.fnUntraced(
    function* (
      threadId: ThreadId,
      input: { readonly sourcePath: string; readonly sizeBytes: number },
    ) {
      const open = findOpen(yield* load(threadId));
      // A continued run keeps its first recording.
      if (!open || open.video !== null) {
        yield* fileSystem.remove(input.sourcePath).pipe(Effect.ignore);
        return;
      }
      const target = path.join(open.dir, "evidence", QA_VIDEO_FILE);
      yield* guard(open, target);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      // A rename fails across devices, so fall back to copying.
      yield* fileSystem
        .rename(input.sourcePath, target)
        .pipe(
          Effect.catch(() =>
            fileSystem
              .copyFile(input.sourcePath, target)
              .pipe(Effect.andThen(fileSystem.remove(input.sourcePath).pipe(Effect.ignore))),
          ),
        );
      yield* save({
        ...open,
        video: { path: target, sizeBytes: input.sizeBytes },
        videoUnavailableReason: null,
      });
    },
    Effect.mapError(failure("Could not save the run's video.")),
  );

  const finishRunUnlocked = Effect.fnUntraced(function* (
    threadId: ThreadId,
    projectId: ProjectId | null,
    kind: QaRun["kind"] = "exploratory",
  ) {
    const open = findOpen(yield* load(threadId));
    if (!open || open.kind !== kind) return null;
    stepCounts.delete(open.runId);
    const finishedAt = yield* nowIso;
    const reportMarkdownPath = path.join(open.dir, "report.md");
    const reportHtmlPath = path.join(open.dir, "report.html");
    const finished: QaRun = {
      ...open,
      projectId,
      finishedAt,
      videoUnavailableReason:
        open.video === null
          ? (open.videoUnavailableReason ?? "No recording was made during this run.")
          : null,
      reportMarkdownPath,
      reportHtmlPath,
    };
    const screenshots = new Map<string, string>();
    for (const scenario of finished.scenarios) {
      const images = [
        scenario.screenshotPath,
        scenario.visual?.baselinePath,
        scenario.visual?.capturePath,
        scenario.visual?.diffPath,
      ];
      for (const image of images) {
        if (image === null || image === undefined) continue;
        const bytes = yield* guard(finished, image).pipe(
          Effect.andThen(fileSystem.readFile(image)),
          Effect.orElseSucceed(() => null),
        );
        if (bytes !== null) screenshots.set(image, Buffer.from(bytes).toString("base64"));
      }
    }
    yield* guard(finished, reportMarkdownPath).pipe(
      Effect.andThen(guard(finished, reportHtmlPath)),
      Effect.andThen(
        fileSystem.writeFileString(reportMarkdownPath, renderMarkdownReport(finished)),
      ),
      Effect.andThen(
        fileSystem.writeFileString(
          reportHtmlPath,
          renderHtmlReport(finished, (screenshotPath) => screenshots.get(screenshotPath) ?? null),
        ),
      ),
      Effect.mapError(failure("Could not write the QA report.")),
    );
    return yield* save(finished);
  });

  const deleteRunUnlocked = Effect.fnUntraced(function* (input: QaRunDeleteInput) {
    const runs = yield* load(input.threadId);
    const run = runs.find((candidate) => candidate.runId === input.runId);
    if (!run) return yield* new QaRunError({ message: "That QA run no longer exists." });
    yield* guard(run, run.dir).pipe(
      Effect.andThen(fileSystem.remove(run.dir, { recursive: true, force: true })),
      Effect.mapError(failure("Could not delete the QA run.")),
    );
    cache.set(
      input.threadId,
      runs.filter((candidate) => candidate.runId !== input.runId),
    );
    yield* PubSub.publish(changes, input.threadId);
    return { runId: input.runId };
  });

  // The helpers above run under these methods' spans and the lock they take.
  const list = Effect.fn("QaRuns.list")(function* (threadId: ThreadId) {
    return yield* lock.withPermit(load(threadId));
  });

  return QaRuns.of({
    ensureRun: Effect.fn("QaRuns.ensureRun")(function* (threadId, input) {
      return yield* lock.withPermit(ensureRunUnlocked(threadId, input.site));
    }),
    openRun: Effect.fn("QaRuns.openRun")(function* (threadId) {
      return findOpen(yield* lock.withPermit(load(threadId))) ?? null;
    }),
    recordEvidence: Effect.fn("QaRuns.recordEvidence")(function* (
      threadId,
      input,
      page,
      checks = [],
    ) {
      return yield* lock.withPermit(recordEvidenceUnlocked(threadId, input, page, checks));
    }),
    appendStep: Effect.fn("QaRuns.appendStep")(function* (threadId, step) {
      yield* lock.withPermit(appendStepUnlocked(threadId, step));
    }),
    readSteps: Effect.fn("QaRuns.readSteps")(function* (run) {
      return yield* readStepsOf(run);
    }),
    startRegressionRun: Effect.fn("QaRuns.startRegressionRun")(function* (threadId, input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const open = findOpen(yield* load(threadId));
          if (open)
            return yield* new QaRunError({
              message:
                open.kind === "regression"
                  ? REPLAY_RUNNING
                  : "This thread has a test run in progress. Wait for it to finish.",
            });
          return yield* createRunUnlocked(threadId, input.site, {
            kind: "regression",
            suiteId: input.suiteId,
            dataRow: input.dataRow,
          });
        }),
      );
    }),
    recordReplayedScenario: Effect.fn("QaRuns.recordReplayedScenario")(
      function* (threadId, input, page, replay) {
        return yield* lock.withPermit(
          recordEvidenceUnlocked(
            threadId,
            input,
            page,
            replay.checks,
            replay.stepCount,
            replay.visual,
          ),
        );
      },
    ),
    markRecordingStarted: Effect.fn("QaRuns.markRecordingStarted")(function* (threadId, startedAt) {
      yield* lock.withPermit(
        updateOpenUnlocked(threadId, (run) => ({
          ...run,
          recordingStartedAt: run.recordingStartedAt ?? startedAt,
        })),
      );
    }),
    attachVideo: Effect.fn("QaRuns.attachVideo")(function* (threadId, input) {
      yield* lock.withPermit(attachVideoUnlocked(threadId, input));
    }),
    markVideoUnavailable: Effect.fn("QaRuns.markVideoUnavailable")(function* (threadId, reason) {
      yield* lock.withPermit(
        updateOpenUnlocked(threadId, (run) =>
          run.video === null ? { ...run, videoUnavailableReason: reason } : run,
        ),
      );
    }),
    finishRun: Effect.fn("QaRuns.finishRun")(function* (threadId, input) {
      return yield* lock.withPermit(finishRunUnlocked(threadId, input.projectId, input.kind));
    }),
    list,
    subscribe: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading so a change in between is not lost.
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = Effect.map(list(threadId), (runs) => ({ runs }));
          return Stream.concat(
            Stream.fromEffect(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === threadId),
              Stream.mapEffect(() => snapshot),
            ),
          );
        }),
      ),
    deleteRun: Effect.fn("QaRuns.deleteRun")(function* (input) {
      return yield* lock.withPermit(deleteRunUnlocked(input));
    }),
  });
});

export const layer = Layer.effect(QaRuns, make);
