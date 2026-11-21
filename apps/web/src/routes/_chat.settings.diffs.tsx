import { createFileRoute, redirect } from "@tanstack/react-router";
import { DiffsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/diffs")({
  // Exploro: old settings URLs lead back to QA settings.
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
  component: DiffsSettingsPanel,
});
