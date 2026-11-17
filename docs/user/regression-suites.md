# Regression suites

A regression suite replays a passed test run without a model. An agent explores a site once, and
you check its verdicts. After that, the same steps and checks rerun for free, as often as you like.

## Save a run as a suite

1. Let an agent finish a test run. When it records a PASS, it saves checks that prove it, such as
   text the page shows or the URL it reached. Exploro tests each check on the live page before
   saving it.
2. Open the thread's **Test run** section and choose **Save as regression**.

Only scenarios that passed and have checks are saved. Exploro tells you which scenarios it left
out and why, for example one that came after a drag and drop, a file upload, a dialog or a
viewport change, which replays cannot repeat yet.

## Replay a suite

- In the thread's **Regression suites** section, choose **Run**.
- From the command palette, choose **Run regression suite…**.
- From a terminal, while Exploro is running:

  ```bash
  exploro regress "shop.test · 2026-11-17"
  ```

  `exploro regress` with no arguments lists your suites. `--all` replays every suite, `--url`
  replays against another origin such as staging, and `--json` prints the runs. It exits with `0`
  when every scenario passes, `1` on a FAIL, `2` when nothing failed but something was
  inconclusive, and `3` when the replay could not start.

- Agents can replay suites with the `qa_regression_run` tool.

A replay runs in a fresh, logged-out browser tab, in the thread the suite was saved from. Its
verdicts appear under **Test run**, labelled **Regression**, with a screenshot, video and reports
like any other run.

## What the verdicts mean

- **PASS**: every saved check held.
- **FAIL**: the steps ran, but a check did not hold. This is a regression in the site.
- **INCONCLUSIVE**: a step could not run, usually because the page changed. The test needs
  updating; it is not a verdict on the site. Scenarios after a broken step are not run.

## Good to know

- Passwords are never saved in a suite. A replay uses the passwords you gave in the thread the
  suite came from, so keep that thread.
- A replay cannot start while an agent is working in that thread.
- Deleting a suite keeps the runs it already made.
