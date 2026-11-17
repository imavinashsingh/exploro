import { qaSiteOrigin } from "@t3tools/contracts";

const MAX_PROJECT_SITES = 20;

/** The site list after adding what the user typed; null when nothing new and valid was typed. */
export function addProjectSites(
  sites: ReadonlyArray<string>,
  draft: string,
): ReadonlyArray<string> | null {
  const next = [...sites];
  for (const entry of draft.split(/[\s,]+/)) {
    if (entry === "") continue;
    const origin = qaSiteOrigin(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`,
    );
    if (origin === null) return null;
    if (!next.includes(origin)) next.push(origin);
  }
  return next.length > sites.length && next.length <= MAX_PROJECT_SITES ? next : null;
}
