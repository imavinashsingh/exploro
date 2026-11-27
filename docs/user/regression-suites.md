# Regression suites

A regression suite replays a passed test run without a model. An agent explores a site once, and
you check its verdicts. After that, the same steps and checks rerun for free, as often as you like.

## Save a run as a suite

1. Let an agent finish a test run. When it records a PASS, it saves checks that prove it, such as
   text the page shows or the URL it reached. Exploro tests each check on the live page before
   saving it.
2. Open the thread's **Test run** section and choose **Save as regression**, or ask the agent to
   create a regression suite.

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

- **PASS**: every saved check held, and the page looks like its baseline.
- **FAIL**: the steps ran, but a check did not hold, or the page looks different from its
  baseline (**FAIL (visual)**). This is a regression in the site.
- **INCONCLUSIVE**: a step could not run, usually because the page changed. The test needs
  updating; it is not a verdict on the site. Scenarios after a broken step are not run.

## Visual checks

Each replay draws the page at a fixed size with animations off, and compares every scenario with
a baseline screenshot. The first replay saves the baseline. Later replays fail when more of the
page differs than the suite allows (1% of pixels by default). The scenario shows the baseline,
the new capture and the difference; if the new look is intended, choose **Accept as new
baseline**.

In the suite's settings, list selectors for content that changes every run, such as a clock, so
both captures hide it. Mask an element that keeps the same size: a mask covers the element's box,
so text that grows or shrinks still moves what is around it.

## Data sets

To replay a suite with different values, open its settings (the gear beside the suite):

1. Under **Data set**, paste or import a CSV. The first row names the parameters, and each later
   row is one replay.
2. Under **Texts**, replace a recorded value with `{{param:name}}`, for example typing
   `{{param:email}}` or checking that the page shows `Welcome {{param:name}}`.

Each row's run is labelled with its row number under **Test run**.

## Running several suites

**Run all in project** replays every suite of the project, and **Run selected** replays the ones
you tick. Replays of different threads run side by side, each in its own browser context; the
rest show **Queued** until a slot frees up. Set how many run at once in **Settings → Maintenance
→ Regression replays at once** (2 by default). The last batch's summary links to the thread that
holds each run.

## Self-healing

Self-healing is off by default. Turn it on in a suite's settings when you expect small UI
changes. When a step's element is gone, the suite asks a model to find the same element on the
page as it is now. By default this is the provider and model the suite was recorded with; you
can pick another, and a provider that cannot do it says "Not available with this provider". Each
call uses that provider's quota.

Healing only proposes. The scenario stays inconclusive, and the suite shows the old and new
element with **Accept and rerun** and **Dismiss**. Healing never adds steps, never changes checks
and never passes a scenario. Accepting updates the step and replays the suite with no AI.

## Good to know

- Passwords are never saved in a suite. A replay uses the passwords you gave in the thread the
  suite came from, so keep that thread.
- A password entered on a sign-in card is used once and then discarded. Scenarios checked after it
  is typed are left out of the suite, and a run with no other scenario cannot be saved. To replay a
  sign-in, give a test account's password in chat instead.
- A replay cannot start while an agent is working in that thread.
- Deleting a suite keeps the runs it already made.

## Where results are saved

A project keeps everything in its `qa-runs` folder: one folder per run with the reports,
screenshots, video and logs, and the suites and their baseline images under `qa-runs/suites`.
Open **Files** to browse them. Anyone who can edit the project, including an agent, can change
these files. Threads without a project save in Exploro's data directory instead.

Runs and suites saved by earlier versions move into their project the next time Exploro starts.
