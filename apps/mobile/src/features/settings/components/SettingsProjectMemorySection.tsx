import {
  mapCoverageLabel,
  mapRows,
  memoryStatusLine,
  understandingBadge,
} from "@t3tools/client-runtime/state/projectMemory";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { SettingsSection } from "./SettingsSection";

const SHOWN = 30;
const MAP_ROWS = 60;
const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();

/** Exploro: what QA runs in this project remember. Read-only; manage it on web or desktop. */
export function SettingsProjectMemorySection(props: { readonly project: EnvironmentProject }) {
  const { environmentId, id: projectId } = props.project;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
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
  const status = snapshot.error ?? memoryStatusLine(data?.status ?? null, enabled).text;

  return (
    <SettingsSection title="Memory" footer="Edit or delete memory on web or desktop.">
      <View className="gap-1 p-4">
        <Text className="text-sm text-foreground-muted">{status}</Text>
      </View>
      {rows.length > 0 ? (
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          {rows.slice(0, MAP_ROWS).map((row) => (
            <View key={row.key} style={{ paddingLeft: row.depth * 12 }}>
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {row.kind === "more" ? `+${row.count} more` : row.label}
                {row.kind === "node" && row.page !== null ? (
                  <Text className="text-xs text-foreground-muted">
                    {"  "}
                    {mapCoverageLabel(row.page)}
                  </Text>
                ) : null}
              </Text>
            </View>
          ))}
          {rows.length > MAP_ROWS ? (
            <Text className="text-xs text-foreground-muted">
              +{rows.length - MAP_ROWS} more pages on web or desktop.
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
            {fact.environment}
            {fact.route} · {fact.kind}
          </Text>
        </View>
      ))}
      {data !== null && facts.length === 0 && data.understanding.length === 0 ? (
        <View className="border-t border-border-subtle px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            Nothing yet. Finished test runs in this project add to it.
          </Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
