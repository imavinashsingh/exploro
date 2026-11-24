import type { MemoryDoc } from "@t3tools/contracts";

import { redactText } from "../qa/qaEvidence.ts";
import { hideProvidedSecrets, providedSecrets } from "./providedSecrets.ts";

const REDACTED = "<redacted>";
// Shapes of common credentials, wherever they appear: provider keys, GitHub/Slack/AWS tokens, JWTs.
const TOKEN_SHAPES =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu;
// A labelled credential such as `api_key=…` or `token: …`; the label stays so the note still reads.
const LABELLED_SECRET =
  /\b(api[ _-]?key|access[ _-]?key|client[ _-]?secret|secret|token|otp|one[ -]time code|pin)(\s*(?:is|=|:)\s*)[`"']?[^\s`"',;]+/giu;
const LOOKS_SECRET = /[\d_\W]/u;

/** Removes passwords, keys, tokens and auth headers, so they never reach memory. */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string> = []): string {
  const known = [...new Set([...secrets, ...providedSecrets([text])])].sort(
    (left, right) => right.length - left.length,
  );
  return redactText(hideProvidedSecrets(text, known))
    .replace(TOKEN_SHAPES, REDACTED)
    .replace(LABELLED_SECRET, (match, label: string, separator: string) => {
      const value = match.slice(label.length + separator.length).replace(/^[`"']/u, "");
      // "token is expired" is prose; a credential value carries a digit or symbol.
      return LOOKS_SECRET.test(value) ? `${label}${separator}${REDACTED}` : match;
    });
}

const MAX_USER_TEXT_CHARS = 8000;
const MAX_STEER_CHARS = 1000;
// Steers win the budget, but never starve the request that set up the run.
const INITIAL_RESERVE_CHARS = 2000;

const clip = (text: string, max: number) =>
  max <= 0 ? "" : text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/**
 * The user's messages within one budget, oldest first. Later messages (steers and corrections)
 * are kept newest first; an oversized opening request is cut rather than dropped.
 */
export function budgetUserMessages(
  messages: ReadonlyArray<string>,
  budget = MAX_USER_TEXT_CHARS,
): ReadonlyArray<string> {
  const [initial, ...later] = messages;
  if (initial === undefined) return [];
  let left = budget - Math.min(initial.length, INITIAL_RESERVE_CHARS);
  const kept: Array<string> = [];
  for (const message of later.toReversed()) {
    const text = clip(message, Math.min(MAX_STEER_CHARS, left));
    if (text === "") break;
    kept.unshift(text);
    left -= text.length;
  }
  const head = clip(initial, left + Math.min(initial.length, INITIAL_RESERVE_CHARS));
  return head === "" ? kept : [head, ...kept];
}

export interface RunFlowStep {
  readonly fromName: string;
  readonly fromPath: string;
  readonly action: string;
  readonly toName: string;
  readonly toPath: string;
}

export interface ProposalRun {
  readonly runId: string;
  readonly kind: "exploratory" | "regression";
  readonly remember?: boolean | undefined;
  readonly finishedAt: string | null;
}

export interface ProposalDraft {
  readonly kind: MemoryDoc["kind"];
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly environment: string | null;
  readonly routes: ReadonlyArray<string>;
  readonly body: string;
  readonly rationale: string;
}

const MIN_FLOW_STEPS = 2;
const MAX_FLOW_STEPS = 12;
const MAX_STEERS = 10;
const quote = (text: string) => JSON.stringify(text);

function proposalSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "");
  return slug === "" ? "flow" : slug;
}

/**
 * Draft suggestions from one remembered run: the user's steers for the playbook, and a multi-step
 * setup flow as a guide. Verdicts are never an input, so a one-off FAIL never becomes a rule.
 */
export function synthesizeRunProposals(input: {
  readonly run: ProposalRun;
  readonly environment: string | null;
  /** The user's messages, oldest first, secrets already hidden. */
  readonly userMessages: ReadonlyArray<string>;
  readonly flow: ReadonlyArray<RunFlowStep>;
  readonly secrets?: ReadonlyArray<string>;
}): ReadonlyArray<ProposalDraft> {
  const { run } = input;
  if (run.kind === "regression" || run.remember === false || run.finishedAt === null) return [];
  const scrub = (text: string) => scrubSecrets(text, input.secrets);
  const date = run.finishedAt.slice(0, 10);
  const drafts: Array<ProposalDraft> = [];
  const [request, ...steers] = budgetUserMessages(input.userMessages.map(scrub));
  const kept = steers.filter((text) => text.trim().length > 0).slice(-MAX_STEERS);
  if (kept.length > 0)
    drafts.push({
      kind: "playbook",
      slug: "playbook",
      title: "Project playbook",
      summary: "How this project is tested",
      environment: null,
      routes: [],
      body: [
        `## Steers from run ${run.runId} (${date})`,
        "",
        ...kept.map((text) => `- ${quote(text.replace(/\s+/gu, " ").trim())}`),
        "",
      ].join("\n"),
      rationale: [
        "The user corrected or steered the agent during this run. Keep only standing instructions.",
        ...(request === undefined ? [] : [`Run request: ${quote(request)}`]),
      ].join("\n"),
    });
  const flow = input.flow.slice(0, MAX_FLOW_STEPS);
  const destination = flow.at(-1);
  if (destination !== undefined && flow.length >= MIN_FLOW_STEPS) {
    const slug = `reach-${proposalSlug(destination.toName)}`.slice(0, 66);
    drafts.push({
      kind: "guide",
      slug,
      title: scrub(`Reach ${destination.toName}`).slice(0, 300),
      summary: scrub(`Setup flow to ${destination.toName}, seen in run ${run.runId}`),
      environment: input.environment,
      routes: [...new Set(flow.flatMap((step) => [step.fromPath, step.toPath]))],
      body: [
        `## Setup flow (run ${run.runId}, ${date})`,
        "",
        ...flow.map(
          (step, index) =>
            `${index + 1}. On **${scrub(step.fromName)}** (${step.fromPath}): ${scrub(step.action)} → **${scrub(step.toName)}** (${step.toPath})`,
        ),
        "",
      ].join("\n"),
      rationale: `The agent took ${flow.length} navigation steps to reach this screen. Approve to reuse the path.`,
    });
  }
  return drafts;
}
