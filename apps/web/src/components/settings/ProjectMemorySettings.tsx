import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROJECT_UNDERSTANDING_KINDS,
  type EnvironmentId,
  type ProjectId,
  type ProjectMemoryFact,
  type ProjectMemoryFactKind,
  type ProjectMemoryFactStatus,
  type ProjectMemoryMapPage,
  type ProjectUnderstandingItem,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  EMPTY_FACT_FILTER,
  factFilterOptions,
  factVersions,
  filterFacts,
  mapCoverageLabel,
  mapRows,
  memoryStatusLine,
  understandingBadge,
  understandingByKind,
  type FactFilter,
  type UnderstandingBadge,
} from "@t3tools/client-runtime/state/projectMemory";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ALL = "__all__";
const FACT_STATUSES: ReadonlyArray<ProjectMemoryFactStatus> = [
  "current",
  "stale",
  "superseded",
  "contradicted",
];
const BADGE_VARIANT = {
  confirmed: "success",
  verified: "info",
  hypothesis: "outline",
  "needs review": "warning",
} as const satisfies Record<UnderstandingBadge, string>;
const COVERAGE_VARIANT = {
  failing: "error",
  tested: "success",
  seen: "outline",
} as const satisfies Record<ProjectMemoryMapPage["coverage"], string>;
const KIND_LABEL: Record<(typeof PROJECT_UNDERSTANDING_KINDS)[number], string> = {
  workflow: "Workflows",
  dependency: "Dependencies",
  "test-strategy": "Test strategies",
  lesson: "Lessons",
  "open-question": "Open questions",
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
  return true;
}

function FilterSelect(props: {
  label: string;
  value: string | null;
  options: ReadonlyArray<string>;
  allLabel: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={props.value ?? ALL}
      onValueChange={(value) => props.onChange(value === ALL || value === null ? null : value)}
    >
      <SelectTrigger size="sm" aria-label={props.label} className="min-w-0 max-w-56">
        <SelectValue>{props.value ?? props.allLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={ALL}>{props.allLabel}</SelectItem>
        {props.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FactRow(props: {
  fact: ProjectMemoryFact;
  versions: ReadonlyArray<ProjectMemoryFact>;
  canEdit: boolean;
  onDelete: (fact: ProjectMemoryFact) => void;
  onOpenEvidence: (fact: ProjectMemoryFact) => void;
}) {
  const [open, setOpen] = useState(false);
  const { fact } = props;
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={open ? "Hide details" : "Show details"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium">{fact.key}</span>
            <span className="min-w-0 break-words text-muted-foreground">{fact.value}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
            <span className="truncate">
              {fact.environment}
              {fact.route}
            </span>
            <span>{fact.kind}</span>
            {fact.appVersion ? <span>App {fact.appVersion}</span> : null}
            {fact.status === "current" ? null : <Badge variant="outline">{fact.status}</Badge>}
            <span>
              {fact.author}, {fact.observedAt.slice(0, 10)}
            </span>
          </div>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={!props.canEdit}
          aria-label={`Delete fact ${fact.key}`}
          onClick={() => props.onDelete(fact)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {open ? (
        <div className="ms-7 flex flex-col gap-2 text-xs">
          {fact.detail === null ? null : <p className="text-muted-foreground">{fact.detail}</p>}
          {fact.evidence.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() => props.onOpenEvidence(fact)}
            >
              Open the run with its evidence
            </Button>
          ) : (
            <p className="text-muted-foreground">No evidence: written by the {fact.author}.</p>
          )}
          {props.versions.length > 1 ? (
            <div>
              <p className="font-medium">Versions</p>
              <ol className="flex flex-col gap-0.5">
                {props.versions.map((version) => (
                  <li key={version.factId} className="text-muted-foreground">
                    {version.observedAt.slice(0, 16).replace("T", " ")} · {version.status} ·{" "}
                    {version.value}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function FactsTab(props: {
  facts: ReadonlyArray<ProjectMemoryFact>;
  truncated: boolean;
  canEdit: boolean;
  onDelete: (fact: ProjectMemoryFact) => void;
  onOpenEvidence: (fact: ProjectMemoryFact) => void;
}) {
  const [filter, setFilter] = useState<FactFilter>(EMPTY_FACT_FILTER);
  const options = factFilterOptions(props.facts, filter);
  const shown = filterFacts(props.facts, filter);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <FilterSelect
          label="Filter by environment"
          value={filter.environment}
          options={options.environments}
          allLabel="All environments"
          onChange={(environment) => setFilter({ ...filter, environment, route: null })}
        />
        <FilterSelect
          label="Filter by route"
          value={filter.route}
          options={options.routes}
          allLabel="All routes"
          onChange={(route) => setFilter({ ...filter, route })}
        />
        <FilterSelect
          label="Filter by kind"
          value={filter.kind}
          options={options.kinds}
          allLabel="All kinds"
          onChange={(kind) => setFilter({ ...filter, kind: kind as ProjectMemoryFactKind | null })}
        />
        <FilterSelect
          label="Filter by status"
          value={filter.status}
          options={FACT_STATUSES}
          allLabel="Any status"
          onChange={(status) =>
            setFilter({ ...filter, status: status as ProjectMemoryFactStatus | null })
          }
        />
      </div>
      {shown.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          {props.facts.length === 0
            ? "No facts yet. Finished test runs in this project add them."
            : "No facts match these filters."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((fact) => (
            <FactRow
              key={fact.factId}
              fact={fact}
              versions={factVersions(props.facts, fact)}
              canEdit={props.canEdit}
              onDelete={props.onDelete}
              onOpenEvidence={props.onOpenEvidence}
            />
          ))}
        </ul>
      )}
      {props.truncated ? (
        <p className="text-2xs text-muted-foreground">Showing the newest 2,000 facts.</p>
      ) : null}
    </div>
  );
}

function MapTab(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  facts: ReadonlyArray<ProjectMemoryFact>;
  canEdit: boolean;
  onDelete: (fact: ProjectMemoryFact) => void;
  onOpenEvidence: (fact: ProjectMemoryFact) => void;
}) {
  const map = useEnvironmentQuery(
    serverEnvironment.projectMemoryMap({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  if (map.error !== null)
    return <p className="py-2 text-sm text-destructive-foreground">{map.error}</p>;
  if (map.data === null) return <p className="py-2 text-sm text-muted-foreground">Loading map…</p>;
  if (map.data.environments.length === 0)
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No map yet. It grows as test runs in this project record facts.
      </p>
    );
  const rows = mapRows(map.data, collapsed);
  const selected = rows.find((row) => row.kind === "node" && row.key === selectedKey);
  const page = selected?.kind === "node" ? selected.page : null;
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <ul role="tree" aria-label="Project map" className="flex flex-col">
        {rows.map((row) =>
          row.kind === "more" ? (
            <li
              key={row.key}
              role="treeitem"
              className="py-1 text-2xs text-muted-foreground"
              style={{ paddingInlineStart: `${row.depth * 16 + 28}px` }}
            >
              +{row.count} more
            </li>
          ) : (
            <li
              key={row.key}
              role="treeitem"
              aria-expanded={row.expandable ? row.open : undefined}
              aria-selected={row.key === selectedKey}
              className="flex items-center gap-1 py-0.5"
              style={{ paddingInlineStart: `${row.depth * 16}px` }}
            >
              {row.expandable ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={row.open ? `Collapse ${row.label}` : `Expand ${row.label}`}
                  onClick={() => toggle(row.key)}
                >
                  {row.open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                </Button>
              ) : (
                <span className="size-6 shrink-0" />
              )}
              {row.page === null ? (
                <span className="min-w-0 truncate text-sm text-muted-foreground">{row.label}</span>
              ) : (
                <>
                  <Button
                    size="xs"
                    variant={row.key === selectedKey ? "secondary" : "ghost"}
                    onClick={() => setSelectedKey(row.key === selectedKey ? null : row.key)}
                  >
                    {row.label}
                  </Button>
                  <Badge variant={COVERAGE_VARIANT[row.page.coverage]}>
                    {mapCoverageLabel(row.page)}
                  </Badge>
                  {row.page.needs.map((need) => (
                    <span key={need} className="min-w-0 truncate text-2xs text-muted-foreground">
                      needs: {need}
                    </span>
                  ))}
                </>
              )}
            </li>
          ),
        )}
      </ul>
      {page === null ? null : (
        <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
          <p className="break-all text-xs font-medium">
            {page.environment}
            {page.route}
          </p>
          {page.navigation.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {page.navigation.map((link) => (
                <li key={link.factId} className="break-all">
                  → {link.environment === page.environment ? "" : link.environment}
                  {link.route} ({link.label})
                </li>
              ))}
            </ul>
          ) : null}
          {page.facts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Reached by a link from another page. Nothing recorded here yet.
            </p>
          ) : (
            <ul className="flex flex-col">
              {page.facts.map((fact) => (
                <FactRow
                  key={fact.factId}
                  fact={fact}
                  versions={factVersions(props.facts, fact)}
                  canEdit={props.canEdit}
                  onDelete={props.onDelete}
                  onOpenEvidence={props.onOpenEvidence}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {map.data.workflows.length > 0 ? (
        <div className="border-t border-border/60 pt-2">
          <p className="text-xs font-medium text-muted-foreground">Workflows</p>
          <ul className="flex flex-col gap-1 text-xs">
            {map.data.workflows.map((workflow) => (
              <li key={workflow.itemId}>
                {workflow.statement}
                <span className="block break-all text-muted-foreground">
                  {workflow.pages.map((step) => step.route).join(" → ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ItemHistory(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemId: string;
}) {
  const history = useEnvironmentQuery(
    serverEnvironment.projectMemoryItemHistory({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, itemId: props.itemId },
    }),
  );
  if (history.error !== null) return <p className="text-destructive-foreground">{history.error}</p>;
  if (history.data === null) return <p className="text-muted-foreground">Loading history…</p>;
  return (
    <ol className="flex flex-col gap-0.5">
      {history.data.toReversed().map((version) => (
        <li key={version.version} className="text-muted-foreground">
          v{version.version} · {version.changedAt.slice(0, 16).replace("T", " ")} · {version.author}{" "}
          · {version.status} · {version.statement}
        </li>
      ))}
    </ol>
  );
}

function UnderstandingRow(props: {
  item: ProjectUnderstandingItem;
  environmentId: EnvironmentId;
  facts: ReadonlyMap<string, ProjectMemoryFact>;
  items: ReadonlyMap<string, ProjectUnderstandingItem>;
  canEdit: boolean;
  onSave: (item: ProjectUnderstandingItem, statement: string) => Promise<boolean>;
  onConfirm: (item: ProjectUnderstandingItem) => void;
  onDelete: (item: ProjectUnderstandingItem) => void;
}) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const badge = understandingBadge(item);
  const cited = item.citedFactIds.map((factId) => props.facts.get(factId) ?? null);
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={open ? "Hide details" : "Show details"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <div className="min-w-0 flex-1">
          {draft === null ? (
            <p className="break-words text-sm">{item.statement}</p>
          ) : (
            <Textarea
              aria-label="Statement"
              value={draft}
              maxLength={300}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
            <Badge variant={BADGE_VARIANT[badge]}>{badge}</Badge>
            <span>
              v{item.version} · {item.author}, {item.updatedAt.slice(0, 10)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {draft === null ? (
            <>
              {item.status === "confirmed" ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!props.canEdit}
                  onClick={() => props.onConfirm(item)}
                >
                  Confirm
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={!props.canEdit}
                onClick={() => setDraft(item.statement)}
              >
                Edit
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!props.canEdit}
                aria-label="Delete item"
                onClick={() => props.onDelete(item)}
              >
                <Trash2Icon />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                disabled={draft.trim() === ""}
                onClick={() =>
                  void props.onSave(item, draft.trim()).then((saved) => {
                    if (saved) setDraft(null);
                  })
                }
              >
                Save
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
      {open ? (
        <div className="ms-7 flex flex-col gap-2 text-xs">
          <div>
            <p className="font-medium">Cited facts</p>
            {cited.length === 0 ? (
              <p className="text-muted-foreground">None.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {cited.map((fact, index) => (
                  <li key={item.citedFactIds[index]} className="text-muted-foreground">
                    {fact === null
                      ? "A fact that was deleted"
                      : `${fact.route} · ${fact.key}: ${fact.value}${fact.status === "current" ? "" : ` (${fact.status})`}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {item.dependsOn.length > 0 ? (
            <div>
              <p className="font-medium">Depends on</p>
              <ul className="flex flex-col gap-0.5">
                {item.dependsOn.map((itemId) => (
                  <li key={itemId} className="text-muted-foreground">
                    {props.items.get(itemId)?.statement ?? "A deleted item"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="font-medium">History</p>
            <ItemHistory
              environmentId={props.environmentId}
              projectId={item.projectId}
              itemId={item.itemId}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Exploro: what QA runs in this project remember, and the switch to turn it off. */
export function ProjectMemorySettings(props: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const navigate = useNavigate();
  const enabled = useScopedSettings((settings) => settings.qaMemoryEnabled);
  const updateSettings = useUpdateScopedSettings();
  const [versionEnvironment, setVersionEnvironment] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);
  const [memberKey, setMemberKey] = useState<string | null>(null);
  const [tab, setTab] = useState<"map" | "facts" | "understanding">("map");
  const member =
    props.members.find((candidate) => candidate.physicalProjectKey === memberKey) ??
    props.members[0]!;
  const environmentId = member.environmentId;
  const projectId = member.id;
  const snapshot = useEnvironmentQuery(
    serverEnvironment.projectMemorySnapshot({ environmentId, input: { projectId } }),
  );
  const mapQuery = useEnvironmentQueryRefresh(
    serverEnvironment.projectMemoryMap({ environmentId, input: { projectId } }),
  );
  const refresh = () => {
    snapshot.refresh();
    mapQuery.refresh();
  };
  const canEdit = useAtomValue(serverEnvironment.deleteMemoryFact.permissionAtom(environmentId));
  const deleteFact = useAtomCommand(serverEnvironment.deleteMemoryFact, { label: "delete fact" });
  const updateItem = useAtomCommand(serverEnvironment.updateMemoryItem, {
    label: "update memory item",
  });
  const deleteItem = useAtomCommand(serverEnvironment.deleteMemoryItem, {
    label: "delete memory item",
  });
  const canSetVersion = useAtomValue(
    serverEnvironment.setMemoryAppVersion.permissionAtom(environmentId),
  );
  const setVersion = useAtomCommand(serverEnvironment.setMemoryAppVersion, {
    label: "set tested app version",
  });
  const retry = useAtomCommand(serverEnvironment.retryMemoryExtraction, {
    label: "retry memory extraction",
  });

  const data = snapshot.data;
  const status = memoryStatusLine(data?.status ?? null, enabled);
  const facts = new Map((data?.facts ?? []).map((fact) => [fact.factId, fact]));
  const items = new Map((data?.understanding ?? []).map((item) => [item.itemId, item]));

  const after = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
    const failed = reportFailure(title, result);
    refresh();
    return !failed;
  };
  const onDeleteFact = (fact: ProjectMemoryFact) =>
    void deleteFact({ environmentId, input: { projectId, factId: fact.factId } }).then(
      after("Could not delete the fact"),
    );
  const onOpenEvidence = (fact: ProjectMemoryFact) => {
    const ref = fact.evidence[0];
    if (ref === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ref.threadId },
    });
  };
  const save = (item: ProjectUnderstandingItem, statement: string) =>
    updateItem({
      environmentId,
      input: { projectId, itemId: item.itemId, statement, confirm: true },
    }).then(after("Could not save the item"));

  return (
    <SettingsSection title="Memory">
      <SettingsRow
        serverScoped
        settingKeys={["qaMemoryEnabled"]}
        title="Project memory"
        description="Test runs here remember what they learn about the app and start from it next time. Turning it off keeps what is saved."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ qaMemoryEnabled: Boolean(checked) })}
            aria-label="Project memory"
          />
        }
      />
      <SettingsRow
        title="Status"
        description={
          <>
            {snapshot.error ?? status.text}
            {enabled && data?.status.recallNote
              ? ` Searching by words only: ${data.status.recallNote}`
              : ""}
          </>
        }
        control={
          <div className="flex items-center gap-2">
            {status.tone === "failed" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canEdit}
                onClick={() =>
                  void Promise.all(
                    (data?.status.failedExtractions ?? []).map((failed) =>
                      retry({ environmentId, input: { projectId, runId: failed.runId } }),
                    ),
                  ).then((results) => results.forEach(after("Could not retry")))
                }
              >
                Retry
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Refresh memory"
              onClick={refresh}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        }
      />
      <form
        className="flex flex-col gap-2 py-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setSavingVersion(true);
          try {
            const result = await setVersion({
              environmentId,
              input: {
                projectId,
                environment: versionEnvironment.trim(),
                appVersion: appVersion.trim(),
              },
            });
            if (after("Could not save the app version")(result)) {
              setAppVersion("");
              toastManager.add({ type: "success", title: "App version saved" });
            }
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Could not save the app version",
              description: error instanceof Error ? error.message : String(error),
            });
          }
          setSavingVersion(false);
        }}
      >
        <p className="m-0 text-sm text-muted-foreground">
          Set the version of the app under test. Earlier facts from this site become stale; new
          observations use this version.
        </p>
        <Input
          aria-label="Test site"
          placeholder="https://app.example.com"
          value={versionEnvironment}
          onChange={(event) => setVersionEnvironment(event.target.value)}
          disabled={!canSetVersion || savingVersion}
          required
          type="url"
          maxLength={2048}
        />
        <Input
          aria-label="Tested app version"
          placeholder="App version, e.g. 2.1"
          value={appVersion}
          onChange={(event) => setAppVersion(event.target.value)}
          disabled={!canSetVersion || savingVersion}
          required
          maxLength={100}
        />
        <div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={
              !canSetVersion || savingVersion || !versionEnvironment.trim() || !appVersion.trim()
            }
          >
            {savingVersion ? "Saving…" : "Set app version"}
          </Button>
        </div>
      </form>
      <SettingsRow
        title="Contents"
        control={
          props.members.length > 1 ? (
            <Select
              value={member.physicalProjectKey}
              onValueChange={(value) => setMemberKey(value)}
            >
              <SelectTrigger size="sm" aria-label="Checkout">
                <SelectValue>{member.environmentLabel ?? member.workspaceRoot}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.members.map((candidate) => (
                  <SelectItem
                    key={candidate.physicalProjectKey}
                    value={candidate.physicalProjectKey}
                  >
                    {candidate.environmentLabel ?? candidate.workspaceRoot}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : undefined
        }
      >
        <div className="mt-3 flex flex-col gap-3 pb-2">
          <ToggleGroup
            aria-label="Memory contents"
            value={[tab]}
            onValueChange={(next) => {
              if (next[0] === "map" || next[0] === "facts" || next[0] === "understanding")
                setTab(next[0]);
            }}
          >
            <Toggle value="map">Map</Toggle>
            <Toggle value="facts">
              Facts · {data?.facts.filter((f) => f.status === "current").length ?? 0}
            </Toggle>
            <Toggle value="understanding">Understanding · {data?.understanding.length ?? 0}</Toggle>
          </ToggleGroup>
          {data === null ? null : tab === "map" ? (
            <MapTab
              environmentId={environmentId}
              projectId={projectId}
              facts={data.facts}
              canEdit={canEdit}
              onDelete={onDeleteFact}
              onOpenEvidence={onOpenEvidence}
            />
          ) : tab === "facts" ? (
            <FactsTab
              facts={data.facts}
              truncated={data.factsTruncated}
              canEdit={canEdit}
              onDelete={onDeleteFact}
              onOpenEvidence={onOpenEvidence}
            />
          ) : data.understanding.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Nothing learned yet. After a test run finishes, Exploro notes how the app works.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {understandingByKind(data.understanding).map((group) => (
                <div key={group.kind}>
                  <p className="text-xs font-medium text-muted-foreground">
                    {KIND_LABEL[group.kind]}
                  </p>
                  <ul className="flex flex-col">
                    {group.items.map((item) => (
                      <UnderstandingRow
                        key={item.itemId}
                        item={item}
                        environmentId={environmentId}
                        facts={facts}
                        items={items}
                        canEdit={canEdit}
                        onSave={save}
                        onConfirm={(target) => void save(target, target.statement)}
                        onDelete={(target) =>
                          void deleteItem({
                            environmentId,
                            input: { projectId, itemId: target.itemId },
                          }).then(after("Could not delete the item"))
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
