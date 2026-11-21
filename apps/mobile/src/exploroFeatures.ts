/** Exploro: a QA project is a folder Exploro manages, never a local folder, clone or published repository. */
export const EXPLORO_OFFERS_REPOSITORIES: boolean = false;

// Exploro: retain upstream routes in source, but never offer developer destinations.
const EXPLORO_HIDDEN_DESTINATIONS: ReadonlySet<string> = new Set([
  "pullRequests",
  "files",
  "terminal",
  "review",
  "diffs",
  "development",
  "git",
  "path",
  "pull-request",
  "ComponentCatalog",
  "DraftBranch",
  "DraftFiles",
  "DraftFile",
  "NewTaskBranch",
  "NewTaskFiles",
  "NewTaskFile",
  "ThreadTerminal",
  "ThreadReview",
  "ThreadReviewComment",
  "ThreadFiles",
  "ThreadFile",
  "ThreadGit",
  "ThreadPullRequests",
  "ThreadGitCommit",
  "ThreadGitBranches",
  "ThreadGitConfirm",
  "SettingsWorktrees",
]);

export function isExploroDestinationVisible(name: string) {
  return !EXPLORO_HIDDEN_DESTINATIONS.has(name) && !name.startsWith("PullRequest");
}

export function withoutExploroHiddenScreens<Screens extends Record<string, unknown>>(
  screens: Screens,
): Screens {
  return Object.fromEntries(
    Object.entries(screens).filter(([name]) => isExploroDestinationVisible(name)),
  ) as Screens;
}
