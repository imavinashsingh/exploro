import { createFileRoute, redirect } from "@tanstack/react-router";
import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettings";

export const Route = createFileRoute("/_chat/settings/worktrees")({
  // Exploro: old worktree settings URLs return to QA settings.
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
  component: WorktreesSettingsPanel,
});
