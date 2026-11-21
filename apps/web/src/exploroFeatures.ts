/** Exploro: a QA project is a folder Exploro manages, never a local folder, clone or published repository. */
export const EXPLORO_OFFERS_REPOSITORIES: boolean = false;

// Exploro: workspace files are hidden; evidence attachments still use the file surface.
const EXPLORO_HIDDEN_PANEL_KINDS: ReadonlySet<string> = new Set([
  "terminal",
  "diff",
  "files",
  "file",
  "pull-request",
  "pull-requests",
]);

export function isExploroPanelSurfaceVisible(surface: { kind: string; attachment?: unknown }) {
  return (
    (surface.kind === "file" && surface.attachment !== undefined) ||
    !EXPLORO_HIDDEN_PANEL_KINDS.has(surface.kind)
  );
}

// Exploro: these stable menu chords identify the upstream developer tab actions.
export const EXPLORO_HIDDEN_PANEL_SHORTCUTS: ReadonlySet<string> = new Set([
  "T",
  "F",
  "D",
  "P",
  "L",
]);

// Exploro: git configuration and project scripts are retained only for upstream merges.
export const EXPLORO_SHOW_DEVELOPER_SETTINGS: boolean = false;

// Exploro: keep thread/model mentions and QA context, but hide coding context and setup.
export const EXPLORO_HIDDEN_COMPOSER_ITEMS: ReadonlySet<string> = new Set([
  "path",
  "pull-request",
  "terminal",
  "worktree",
  "changes",
  "open-in",
]);
