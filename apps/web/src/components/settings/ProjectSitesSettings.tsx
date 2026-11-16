import { XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { addProjectSites } from "./ProjectSitesSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

/** Exploro: the sites a QA project tests. The first run in the project fills it in. */
export function ProjectSitesSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const sites = useScopedSettings((settings) => settings.qaSiteOrigins);
  const updateSettings = useUpdateScopedSettings();
  const [draft, setDraft] = useState("");
  const disabled = connectedEnvironments.length === 0;
  const added = addProjectSites(sites, draft);
  const add = () => {
    if (added === null) return;
    updateSettings({ qaSiteOrigins: added });
    setDraft("");
  };

  return (
    <SettingsSection title="Testing">
      <SettingsRow
        serverScoped
        settingKeys={["qaSiteOrigins"]}
        title="Sites"
        description={
          sites.length === 0
            ? "The sites this project tests. The first site you test here is added for you."
            : "The sites this project tests."
        }
      >
        <div className="mt-3 flex flex-col gap-2 pb-2">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              className="min-w-0 flex-1"
              value={draft}
              disabled={disabled}
              placeholder="https://staging.example.com"
              aria-label="Add a site"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key !== "Enter") return;
                event.preventDefault();
                add();
              }}
            />
            <Button size="sm" variant="outline" disabled={disabled || added === null} onClick={add}>
              Add
            </Button>
          </div>
          {sites.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {sites.map((site) => (
                <li key={site} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{site}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    aria-label={`Remove ${site}`}
                    onClick={() =>
                      updateSettings({ qaSiteOrigins: sites.filter((entry) => entry !== site) })
                    }
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
