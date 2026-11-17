import { QaRun, QaSuiteSummary } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { isThreadCliError, withThreadTools } from "./thread.ts";

/** Exit 1: a check failed on replay, a real regression. */
export class RegressFailedError extends Schema.TaggedError<RegressFailedError>()(
  "RegressFailedError",
  { count: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `${this.count} scenario${this.count === 1 ? "" : "s"} failed.`;
  }
}

/** Exit 2: nothing failed, but a step could not run, so a test needs updating. */
export class RegressInconclusiveError extends Schema.TaggedError<RegressInconclusiveError>()(
  "RegressInconclusiveError",
  { count: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;
  override get message(): string {
    return `${this.count} scenario${this.count === 1 ? " was" : "s were"} inconclusive: the test needs updating.`;
  }
}

/** Exit 3: the replay could not start, such as no running server or an unknown suite. */
export class RegressStartError extends Schema.TaggedError<RegressStartError>()(
  "RegressStartError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 3;
  override get message(): string {
    return this.detail;
  }
}

const SuiteList = Schema.Struct({ suites: Schema.Array(QaSuiteSummary) });
const RunResult = Schema.Struct({ run: QaRun });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Picks suites by id or name; `--all` takes every one. */
function selectSuites(
  suites: ReadonlyArray<QaSuiteSummary>,
  wanted: ReadonlyArray<string>,
  all: boolean,
): { readonly suites: ReadonlyArray<QaSuiteSummary> } | { readonly unknown: string } {
  if (all) return { suites };
  const picked: Array<QaSuiteSummary> = [];
  for (const name of wanted) {
    const lower = name.trim().toLowerCase();
    const match =
      suites.find((suite) => suite.suiteId === name.trim()) ??
      suites.find((suite) => suite.name.toLowerCase() === lower);
    if (match === undefined) return { unknown: name };
    picked.push(match);
  }
  return { suites: picked };
}

export const regressCommand = Command.make("regress", {
  ...projectLocationFlags,
  suites: Argument.String("suite").pipe(
    Argument.withDescription("Suite id or name. Repeat for several."),
    Argument.variadic,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Replay every saved suite."),
    Flag.withDefault(false),
  ),
  url: Flag.String("url").pipe(
    Flag.withDescription("Replay against this origin instead, such as a staging URL."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the finished runs as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Replay saved regression suites without a model on the running server. Exits 0 when every scenario passes, 1 on a FAIL, 2 when only inconclusive, 3 when it could not start.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const runs = yield* withThreadTools(
        flags,
        Effect.fn("cli.regress")(function* (tools) {
          const { suites } = yield* tools.call("qa_regression_list", {}, SuiteList);
          if (!flags.all && flags.suites.length === 0) {
            for (const suite of suites)
              yield* Console.log(
                `${suite.suiteId}  ${suite.scenarioCount} scenarios  ${suite.name}`,
              );
            return [];
          }
          const selected = selectSuites(suites, flags.suites.map(String), flags.all);
          if ("unknown" in selected)
            return yield* new RegressStartError({
              detail: `No regression suite is named '${selected.unknown}'. Run 'exploro regress' to list them.`,
            });
          const finished: Array<QaRun> = [];
          for (const suite of selected.suites) {
            const { run } = yield* tools.call(
              "qa_regression_run",
              {
                suiteId: suite.suiteId,
                ...Option.match(flags.url, {
                  onNone: () => ({}),
                  onSome: (url) => ({ baseUrl: url }),
                }),
              },
              RunResult,
            );
            finished.push(run);
            if (flags.json) continue;
            yield* Console.log(`${suite.name} · ${run.scenarios.length} scenarios`);
            for (const scenario of run.scenarios) {
              yield* Console.log(
                `  ${scenario.verdict.padEnd(12)} ${scenario.scenario}${
                  scenario.verdict === "PASS" ? "" : `  ${scenario.actual ?? scenario.note}`
                }`,
              );
            }
            if (run.reportHtmlPath !== null) yield* Console.log(`Report: ${run.reportHtmlPath}`);
          }
          return finished;
        }),
      ).pipe(
        Effect.mapError((error) =>
          isThreadCliError(error) ? new RegressStartError({ detail: error.message }) : error,
        ),
      );
      if (flags.json) yield* Console.log(encodeJson(runs));
      const scenarios = runs.flatMap((run) => run.scenarios);
      const failed = scenarios.filter((scenario) => scenario.verdict === "FAIL").length;
      if (failed > 0) return yield* new RegressFailedError({ count: failed });
      const unsure = scenarios.filter((scenario) => scenario.verdict !== "PASS").length;
      if (unsure > 0) return yield* new RegressInconclusiveError({ count: unsure });
    }).pipe(
      Effect.tapError((error) =>
        "message" in error && typeof error.message === "string"
          ? Console.error(error.message)
          : Effect.void,
      ),
    ),
  ),
);
