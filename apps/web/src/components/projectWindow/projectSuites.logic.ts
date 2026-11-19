import type { QaRegressionBatch, QaRegressionJob, QaRun, QaSuiteSummary } from "@t3tools/contracts";

export type SuiteLastReplay = Pick<
  QaRegressionJob,
  "status" | "counts" | "error" | "threadId" | "runId"
>;

const countsOf = (run: QaRun) => ({
  pass: run.scenarios.filter((scenario) => scenario.verdict === "PASS").length,
  fail: run.scenarios.filter((scenario) => scenario.verdict === "FAIL").length,
  inconclusive: run.scenarios.filter(
    (scenario) => scenario.verdict !== "PASS" && scenario.verdict !== "FAIL",
  ).length,
});

/**
 * The suite's newest replay. Batches are in-memory on the server and vanish on restart,
 * so without one the newest finished run saved for the suite stands in.
 */
export function suiteLastReplay(
  suite: Pick<QaSuiteSummary, "suiteId">,
  batches: ReadonlyArray<QaRegressionBatch>,
  runs: ReadonlyArray<QaRun>,
): SuiteLastReplay | null {
  for (const batch of batches) {
    const jobs = batch.jobs.filter((job) => job.suiteId === suite.suiteId);
    if (jobs.length > 0) return jobs.find((job) => job.status === "running") ?? jobs[0]!;
  }
  let newest: QaRun | null = null;
  for (const run of runs) {
    if (run.suiteId !== suite.suiteId || run.finishedAt === null) continue;
    if (newest === null || run.finishedAt > newest.finishedAt!) newest = run;
  }
  if (newest === null) return null;
  return {
    status: "done",
    counts: countsOf(newest),
    error: null,
    threadId: newest.threadId,
    runId: newest.runId,
  };
}
