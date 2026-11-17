import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const PROVIDED_PASSWORD = "<provided password>";
const PASSWORD_GIVEN =
  /\b(?:password|passwd|pwd|passcode|passphrase)\b\s*(?:is|=|:|-)?\s*(?:[`"']([^`"'\s]+)[`"']|([^\s`"',;<]\S*))/giu;
// Words after "password" are usually prose ("password is rejected"); passwords carry a digit,
// underscore or symbol. A plain-word password is missed rather than hiding ordinary words.
const LOOKS_SECRET = /[\d_\W]/u;

/** Passwords the user typed in chat ("the password is secret_sauce"), longest first. */
export function providedSecrets(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...providedSecretsInOrder(texts)].sort((left, right) => right.length - left.length);
}

/** The same passwords in the order the user gave them, so each keeps its number. */
function providedSecretsInOrder(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PASSWORD_GIVEN)) {
      // A quoted password is exact; a bare one may end with the sentence's punctuation.
      const secret = match[1] ?? (match[2] ?? "").replace(/[.,;:)\]]+$/u, "");
      if (secret.length >= 3 && LOOKS_SECRET.test(secret)) found.add(secret);
    }
  }
  return [...found];
}

export function hideProvidedSecrets(text: string, secrets: ReadonlyArray<string>): string {
  return secrets.reduce((hidden, secret) => hidden.split(secret).join(PROVIDED_PASSWORD), text);
}

/** The passwords the user gave in a thread, so memory never stores them. */
export const threadProvidedSecrets = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
) =>
  threads
    .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
    .pipe(
      Effect.map((records) => providedSecrets(records.messages.map((message) => message.text))),
    );

/** The thread's passwords in the order given; a saved suite's `{{secret:N}}` counts in it. */
export const threadProvidedSecretsInOrder = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
) =>
  threads
    .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
    .pipe(
      Effect.map((records) =>
        providedSecretsInOrder(records.messages.map((message) => message.text)),
      ),
    );
