# Project Navigation Memory benchmark

Measures reaching a feature, independently of whether testing that feature succeeds. Uses
OrangeHRM's public demo and Exploro's existing thread orchestration and built-in browser.
The driver starts an isolated server; it does not introduce another browser or agent loop.

| Mode         | Memory available to the agent                                       |
| ------------ | ------------------------------------------------------------------- |
| A: `none`    | No project facts or navigation tools                                |
| B: `current` | Existing facts and understanding                                    |
| C: `graph`   | Observed states and connections, with bounded breadth-first routing |

Five deep cases name a configuration screen by its purpose, not its menu label, so the agent must
find it inside a module's dropdown. Two shallow controls (personal details, and the candidate form
from signed out) check that memory stays cheap where it cannot help. A deep case was kept only if
the live page marks its title as a heading.

Six click-only cases check graph routing where an address jump is not allowed. Each starts on
one remembered screen, or signed out, and must reach a screen in another module. The seed explores
only from Dashboard, so these routes must be joined from separate observations.
The prompt forbids opening addresses; check that trials obeyed it before comparing them. The pilot verifies the starting states and destination URL plus visible heading
against the live demo, records its actual version, and excludes unsupported cases before trials.
It does not prove the website works beyond those arrival checks.

## Run

From the repository root, after `vp i`, use the cheapest configured Claude model explicitly.
The example pins Haiku; use a model available to your configured Claude instance.

```sh
node evals/project-navigation/prepare.ts --pilot-only --out /tmp/navigation-pilot
node evals/project-navigation/prepare.ts --model claude-haiku-5-5 --out /tmp/navigation-seed
node evals/project-navigation/run.ts --model claude-haiku-5-5 --out /tmp/navigation-schedule --dry-run
node evals/project-navigation/run.ts --model claude-haiku-5-5 --out /tmp/navigation-smoke --driver evals/project-navigation/live-driver.ts --seed /tmp/navigation-seed --case dashboard-personal --samples 1
node evals/project-navigation/run.ts --model claude-haiku-5-5 --out /tmp/navigation-comparison --driver evals/project-navigation/live-driver.ts --seed /tmp/navigation-seed
```

Use new output directories. A full schedule is 13 cases × 3 modes × 5 repetitions = 195 trials.
`--shuffle` fixes the randomized order; `--case` and `--mode` accept comma-separated case IDs and modes. `--resume` with
an earlier `--out` skips trials already recorded there for the same seed, model, and website
version, and summarizes only the requested schedule. Each live
comparison repeats the independent pilot. `prepare` learns with a real agent and refuses a
seed without facts, and an observed connection into every destination. The
learning turn gets ten minutes. Inspect it before use: the quality of learned checks matters too.

The seed must be stopped before copying. Every trial gets its own database, browser profile,
fresh project workspace, and fresh thread. Only installed browser binaries are shared. The
runner hashes the complete source snapshot before and after the comparison and pins the seed's
model and website version. `prepare --provider codex` learns with Codex instead of Claude; trials use the
seed's provider. Claude runs with `--strict-mcp-config`; Codex runs with plugins, apps, and browser
and computer use disabled, and every remaining MCP server of its own config switched off, so only Exploro's tools reach the agent, never the user's MCP servers. It disables unrelated memory for each mode; trial learning never
flows back into the seed or the next trial. Keep trial artifacts private: they contain local
server credentials and the demo's session state. They belong outside git.

## Reading results

`schedule.json` records the intended experiment, `pilot.json` records eligibility and skipped
cases, `results.ndjson` preserves every eligible outcome, and `summary.json` groups results by
case and mode. Arrival requires completed orchestration plus an independent live URL and
visible heading check. The model's final answer cannot award success. A timeout, more than 40
recorded primitive actions, a blocker, no agent tab, or infrastructure failure cannot pass. Actions
are counted on the agent's final tab. The 40-action
threshold is graded after execution; the orchestration deadline interrupts a trial after three
minutes. Starting-page setup is outside the measurement interval.

Input, output, and cached token counts come from provider telemetry; cached tokens are reported
separately and are not added to total input again. Missing telemetry stays `null`. Preparation
cost and time are reported separately and must be amortized across actual later uses; they are
not free. Summaries keep failures and unknown usage in their denominators. Successful-trial
medians alone must not be interpreted as an overall win. Compare success rates first, then time,
actions, failures, and tokens within the same case. This is a screening experiment on a shared,
mutable demo, not a confidence claim about all websites.

Live runs cost the configured provider's normal usage, including learning and failed trials.
Pilot and `--dry-run` start no model. Estimate a full batch from the four-trial smoke before
running it. Provider authentication is the existing Exploro configuration, not a new API bridge.

## Extend and validate

Add a case to `cases.ts` only with a reproducible starting state and independently checkable
arrival. A different site needs a driver that implements `NavigationDriver`; keep its verification
outside the agent. `benchmark.test.ts` covers the grader, token accounting, missing usage, and
balanced scheduling. `mcp-tool-use/cases/project-navigation.ndjson` separately checks model use
of navigation tools and fallback when a route is missing; those simulated cases do not measure
real website navigation speed.
