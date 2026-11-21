import { EXPLORO_HIDDEN_COMPOSER_ITEMS } from "../../exploroFeatures";
import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly hostEnvironmentId: string | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  // Exploro: editor launchers are outside the QA workflow.
  if (EXPLORO_HIDDEN_COMPOSER_ITEMS.has("open-in")) return false;
  if (!input.activeProjectName) return false;
  if (
    input.activeThreadEnvironmentId === input.primaryEnvironmentId ||
    input.activeThreadEnvironmentId === input.hostEnvironmentId
  ) {
    return true;
  }
  return input.remoteOpenMode !== "local-exec";
}
