import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { RepeatIcon } from "lucide-react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useRunRegressionSuite } from "./chat/ThreadDetailsRegression";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

/** "Run regression suite…", listing every saved suite; null when there are none. */
export function useCommandPaletteRegressionItem(
  environmentId: EnvironmentId | null,
): CommandPaletteSubmenuItem | null {
  const suitesQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.qaSuitesLive({ environmentId, input: {} }),
  );
  const canRun = useAtomValue(serverEnvironment.runQaSuite.permissionAtom(environmentId));
  const runSuite = useRunRegressionSuite(environmentId);
  const suites = suitesQuery.data?.suites ?? [];
  if (environmentId === null || !canRun || suites.length === 0) return null;
  return {
    kind: "submenu",
    value: "action:run-regression-suite",
    searchTerms: ["run regression suite", "regression", "replay", "retest", "suite", "qa"],
    title: "Run regression suite…",
    icon: <RepeatIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <RepeatIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "regression-suites",
        label: "Run regression suite",
        items: suites.map((suite) => ({
          kind: "action",
          value: `regression-suite:${suite.suiteId}`,
          title: suite.name,
          description: `${suite.scenarioCount} scenarios${suite.site ? ` · ${suite.site}` : ""}`,
          searchTerms: [suite.name, suite.site ?? "", "regression", "suite"],
          icon: <RepeatIcon className={ITEM_ICON_CLASS} />,
          run: () => runSuite(suite),
        })),
      },
    ],
  };
}
