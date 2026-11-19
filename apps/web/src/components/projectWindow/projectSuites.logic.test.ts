import type { QaRegressionBatch, QaRun, QaVerdict } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { suiteLastReplay } from "./projectSuites.logic";

const suite = { suiteId: "suite-a" } as const;

const run = (
  runId: string,
  suiteId: string | null,
  finishedAt: string | null,
  verdicts: ReadonlyArray<QaVerdict>,
): QaRun =>
  ({
    runId,
    threadId: `thread-${runId}`,
    kind: "regression",
    suiteId,
    finishedAt,
    scenarios: verdicts.map((verdict) => ({ verdict })),
  }) as unknown as QaRun;

const batch = (status: "running" | "done"): QaRegressionBatch =>
  ({
    jobs: [{ suiteId: "suite-a", status, threadId: "thread-live", runId: null, counts: null }],
  }) as unknown as QaRegressionBatch;

describe("suiteLastReplay", () => {
  it("falls back to the newest finished saved replay when the server has no batch", () => {
    const replay = suiteLastReplay(
      suite,
      [],
      [
        run("old", "suite-a", "2026-11-17T00:00:00Z", ["FAIL"]),
        run("new", "suite-a", "2026-11-18T00:00:00Z", ["PASS", "PASS", "BLOCKED"]),
        run("open", "suite-a", null, ["PASS"]),
        run("other", "suite-b", "2026-11-19T00:00:00Z", ["PASS"]),
      ],
    );
    expect(replay).toEqual({
      status: "done",
      counts: { pass: 2, fail: 0, inconclusive: 1 },
      error: null,
      threadId: "thread-new",
      runId: "new",
    });
  });

  it("prefers a live batch job over saved runs", () => {
    const replay = suiteLastReplay(
      suite,
      [batch("running")],
      [run("new", "suite-a", "2026-11-18T00:00:00Z", ["PASS"])],
    );
    expect(replay?.status).toBe("running");
    expect(replay?.threadId).toBe("thread-live");
  });

  it("is null when the suite never ran", () => {
    expect(
      suiteLastReplay(suite, [], [run("x", null, "2026-11-18T00:00:00Z", ["PASS"])]),
    ).toBeNull();
  });
});
