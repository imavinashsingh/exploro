<p align="center">
  <a href="https://imavinashsingh.github.io/exploro/">
    <img src="./assets/brand/mark.svg" width="80" height="80" alt="Exploro logo" />
  </a>
</p>

<h1 align="center">Exploro</h1>

<p align="center">Exploratory QA, with evidence.</p>

<p align="center">
  <a href="https://imavinashsingh.github.io/exploro/#download"><strong>Download</strong></a> ·
  <a href="https://imavinashsingh.github.io/exploro/">Website</a> ·
  <a href="https://github.com/imavinashsingh/exploro/releases">Releases</a> ·
  <a href="./EXPLORO.md">Develop</a>
</p>

Exploro is an open-source app for manual QA engineers. Give it a website and a testing goal. An agent tests the site in a real browser while you watch, take over when you want, and get a report with a verdict and screenshots for every scenario.

Exploro is in beta. It is a QA-focused fork of [T3 Code](https://github.com/pingdotgg/t3code).

## How it works

1. **Name the site and goal.** Paste a URL and describe what to test, in plain words. Add test credentials if the flow needs them.
2. **The agent explores.** It opens the site in Exploro's built-in browser and works through the flow like a careful tester, scenario by scenario.
3. **Watch or take over.** The browser runs beside the chat. Step in at any point, and approve anything risky before it happens.
4. **Keep the evidence.** Each run ends with a report: a verdict per scenario, screenshots, and the console and network errors behind them.

## What you get

- **A real browser.** Tests run in Chromium with screenshots, console, and network capture.
- **Report only.** The agent tests what is deployed. It never edits your code, and it treats text on the page as data, not instructions.
- **Asks before it acts.** Payments, deletions, sending messages, and other irreversible steps wait for your approval.
- **Your agent, your account.** Exploro drives the agent you are already signed in to: Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Kiro, Pi, or any [ACP](./docs/user/providers-acp.md) agent. It does not resell tokens.
- **Evidence on disk.** Runs are saved in `~/.exploro` as Markdown and a self-contained HTML report you can attach to a bug ticket.

## Verdicts

A wrong PASS is the worst result a tester can give, so every scenario ends with one of five verdicts. A verdict without a screenshot is stored as INCONCLUSIVE, whatever the agent claimed.

| Verdict      | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| PASS         | The expected behaviour was seen and captured.                                   |
| FAIL         | The site did something different from what was expected.                        |
| BLOCKED      | The agent could not continue: a login, a missing approval, or an earlier break. |
| INCONCLUSIVE | There is not enough evidence to say either way.                                 |
| SKIPPED      | Out of scope for this run, or you chose to leave it.                            |

## Install

Download the latest build from the [website](https://imavinashsingh.github.io/exploro/#download) or [Releases](https://github.com/imavinashsingh/exploro/releases):

| Platform    | File                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Windows x64 | `.exe` installer. The build is unsigned, so SmartScreen may warn you: choose **More info**, then **Run anyway**. |
| Linux x64   | `.AppImage`. Run `chmod +x` on the file, then start it.                                                          |

Exploro needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. [Provider setup](./docs/user/install.md#providers) has the steps for each agent.

## Build from source

```bash
git clone https://github.com/imavinashsingh/exploro.git
cd exploro
vp i
vp run dev --home-dir ~/.exploro/dev
```

[EXPLORO.md](./EXPLORO.md) covers Exploro's decisions, development setup, and workflow. [AGENTS.md](./AGENTS.md) describes the T3 Code codebase underneath.

## Contributing

Work is tracked as [GitHub issues](https://github.com/imavinashsingh/exploro/issues). Open one before a pull request, and keep each pull request to one problem.

## License

[MIT](./LICENSE). Exploro builds on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., which keeps its copyright notice.
