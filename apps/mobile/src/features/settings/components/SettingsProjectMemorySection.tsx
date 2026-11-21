import {
  mapCoverageLabel,
  mapRows,
  memoryStatusLine,
  understandingBadge,
} from "@t3tools/client-runtime/state/projectMemory";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SettingsSection } from "./SettingsSection";

const SHOWN = 30;
const MAP_ROWS = 60;
const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();

/** Exploro: project memory settings and a summary of what QA runs remember. */
export function SettingsProjectMemorySection(props: { readonly project: EnvironmentProject }) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, id: projectId } = props.project;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update project memory",
    reportFailure: true,
  });
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const enabled =
    config === null || resolveProjectSettings(config.settings, projectId).settings.qaMemoryEnabled;
  const snapshot = useEnvironmentQuery(
    serverEnvironment.projectMemorySnapshot({ environmentId, input: { projectId } }),
  );
  const map = useEnvironmentQuery(
    serverEnvironment.projectMemoryMap({ environmentId, input: { projectId } }),
  );
  const rows = map.data === null ? [] : mapRows(map.data, NOTHING_COLLAPSED);
  const data = snapshot.data;
  const facts = data?.facts.filter((fact) => fact.status === "current") ?? [];
  const status = snapshot.error ?? memoryStatusLine(data?.status ?? null, enabled, messages).text;

  return (
    <SettingsSection
      title={gt("Memory", { $context: "settings section: what test runs remember" })}
      footer={gt("Edit or delete memory on web or desktop.")}
    >
      <SettingsSwitchRow
        label={gt("Project memory")}
        value={enabled}
        disabled={!canUpdate || config === null}
        onValueChange={(qaMemoryEnabled) =>
          void updateSettings({
            environmentId,
            input: {
              patch: {
                projectSettingsOverrides: {
                  ...config?.settings.projectSettingsOverrides,
                  [projectId]: {
                    ...config?.settings.projectSettingsOverrides[projectId],
                    qaMemoryEnabled,
                  },
                },
              },
            },
          })
        }
      />
      <View className="gap-1 p-4">
        <Text className="text-sm text-foreground-muted">{status}</Text>
      </View>
      {data?.navigation ? (
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          <Text className="text-sm text-foreground">{gt("Project Navigation Memory")}</Text>
          {data.navigation.transitions.slice(0, SHOWN).map((edge) => (
            <View key={edge.id} className="gap-1 py-1">
              <Text className="text-sm text-foreground">
                {data.navigation!.states.find((state) => state.id === edge.from)?.name ?? "?"} →{" "}
                {data.navigation!.states.find((state) => state.id === edge.to)?.name ?? "?"}
              </Text>
              <Text className="text-xs text-foreground-muted">{edge.action}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {rows.length > 0 ? (
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          {rows.slice(0, MAP_ROWS).map((row) => (
            <View key={row.key} style={{ paddingLeft: row.depth * 12 }}>
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {row.kind === "more" ? gt("+{count} more", { count: row.count }) : row.label}
                {row.kind === "node" && row.page !== null ? (
                  <Text className="text-xs text-foreground-muted">
                    {"  "}
                    {mapCoverageLabel(row.page, messages)}
                  </Text>
                ) : null}
              </Text>
            </View>
          ))}
          {rows.length > MAP_ROWS ? (
            <Text className="text-xs text-foreground-muted">
              {gt("+{count} more pages on web or desktop.", { count: rows.length - MAP_ROWS })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {data?.understanding.slice(0, SHOWN).map((item) => (
        <View key={item.itemId} className="gap-0.5 border-t border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">{item.statement}</Text>
          <Text className="text-xs text-foreground-muted">
            {item.kind} · {understandingBadge(item)}
          </Text>
        </View>
      ))}
      {facts.slice(0, SHOWN).map((fact) => (
        <View key={fact.factId} className="gap-0.5 border-t border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">
            {fact.key}: {fact.value}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {fact.stateName} · {fact.environment}
            {fact.route} · {fact.kind}
          </Text>
        </View>
      ))}
      {data !== null && facts.length === 0 && data.understanding.length === 0 ? (
        <View className="border-t border-border-subtle px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            <T>Nothing yet. Finished test runs in this project add to it.</T>
          </Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
