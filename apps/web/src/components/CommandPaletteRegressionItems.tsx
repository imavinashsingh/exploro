import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { RepeatIcon } from "lucide-react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useRunRegressionSuites } from "./chat/ThreadDetailsRegression";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

/** "Run regression suite…", listing every saved suite; null when there are none. */
export function useCommandPaletteRegressionItem(
  environmentId: EnvironmentId | null,
): CommandPaletteSubmenuItem | null {
  const gt = useGT();
  const suitesQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.qaSuitesLive({ environmentId, input: {} }),
  );
  const canRun = useAtomValue(serverEnvironment.runQaSuite.permissionAtom(environmentId));
  const runSuites = useRunRegressionSuites(environmentId);
  const suites = suitesQuery.data?.suites ?? [];
  if (environmentId === null || !canRun || suites.length === 0) return null;
  return {
    kind: "submenu",
    value: "action:run-regression-suite",
    searchTerms: ["run regression suite", "regression", "replay", "retest", "suite", "qa"],
    title: gt("Run regression suite…"),
    icon: <RepeatIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <RepeatIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "regression-suites",
        label: gt("Run regression suite"),
        items: [
          ...(suites.length > 1
            ? [
                {
                  kind: "action" as const,
                  value: "regression-suite:all",
                  title: gt("Run all regression suites"),
                  description: gt("{count} suites, queued by the server", { count: suites.length }),
                  searchTerms: ["all", "regression", "suites", "batch"],
                  icon: <RepeatIcon className={ITEM_ICON_CLASS} />,
                  run: () => runSuites(suites, gt("All suites")),
                },
              ]
            : []),
          ...suites.map((suite) => ({
            kind: "action" as const,
            value: `regression-suite:${suite.suiteId}`,
            title: suite.name,
            description: `${gt("{count} scenarios", { count: suite.scenarioCount })}${suite.site ? ` · ${suite.site}` : ""}`,
            searchTerms: [suite.name, suite.site ?? "", "regression", "suite"],
            icon: <RepeatIcon className={ITEM_ICON_CLASS} />,
            run: () => runSuites([suite]),
          })),
        ],
      },
    ],
  };
}
