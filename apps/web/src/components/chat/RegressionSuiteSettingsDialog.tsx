import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  QaSuite,
  QaSuiteId,
} from "@t3tools/contracts";
import { T, Var, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { getTextGenerationModelOptionsByInstance } from "../../modelSelection";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTextGenerationTargets } from "../../textGenerators";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { applyTexts, csvFromDataSet, dataSetFromCsv, editableTexts } from "./regressionSuite.logic";

const EMPTY_PROVIDERS: never[] = [];

/** The healing model, and whether its provider can heal at all. */
function HealingModel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = useEnvironmentProviders().get(props.environmentId) ?? EMPTY_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId: props.environmentId,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: props.projectId,
    selections: [props.selection],
  });
  if (props.selection === null)
    return (
      <p className="m-0 text-xs text-muted-foreground">
        <T>This suite was saved before its model was recorded. Choose one to heal with.</T>
      </p>
    );
  const available = targets.entries.some(
    (entry) =>
      entry.instanceId === props.selection?.instanceId && entry.enabled && entry.isAvailable,
  );
  return (
    <div className="flex flex-col gap-1">
      <ProviderModelPicker
        environmentId={props.environmentId}
        activeInstanceId={props.selection.instanceId}
        model={props.selection.model}
        lockedProvider={null}
        instanceEntries={targets.entries}
        modelOptionsByInstance={getTextGenerationModelOptionsByInstance(
          settings,
          targets.providers,
          props.selection.instanceId,
          props.selection.model,
        )}
        onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
          props.onChange({ instanceId, model })
        }
      />
      {available ? null : (
        <p className="m-0 text-xs text-warning-foreground">
          {gt("Not available with this provider.")}
        </p>
      )}
    </div>
  );
}

/** Edits a suite's look check, data set, text and healing. Steps and checks keep their shape. */
export function RegressionSuiteSettingsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly suite: QaSuite;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { suite } = props;
  const update = useAtomCommand(serverEnvironment.updateQaSuite, {
    label: "update regression suite",
    reportFailure: false,
  });
  const texts = editableTexts(suite, messages);
  const [name, setName] = useState(suite.name);
  const [thresholdPercent, setThresholdPercent] = useState(String(suite.visual.threshold * 100));
  const [masks, setMasks] = useState(suite.visual.masks.join("\n"));
  const [csv, setCsv] = useState(csvFromDataSet(suite.dataSet));
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [healing, setHealing] = useState(suite.healing.enabled);
  const [healingModel, setHealingModel] = useState(
    suite.healing.modelSelection ?? suite.recordedWith,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const threshold = Number(thresholdPercent) / 100;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      return setError(gt("The allowed difference is a percentage from 0 to 100."));
    const dataSet = dataSetFromCsv(csv, messages);
    if ("error" in dataSet) return setError(dataSet.error);
    setSaving(true);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        suiteId: suite.suiteId as QaSuiteId,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        visual: {
          threshold,
          masks: masks
            .split("\n")
            .map((mask) => mask.trim())
            .filter((mask) => mask !== ""),
        },
        dataSet,
        healing: {
          enabled: healing,
          modelSelection:
            healingModel === null || healingModel === suite.recordedWith ? null : healingModel,
        },
        ...applyTexts(suite, edits),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : gt("Could not save the suite."));
      }
      return;
    }
    toastManager.add({ type: "success", title: gt("Saved {name}", { name: result.value.name }) });
    props.onClose();
  };

  const importCsv = (file: File | undefined) => {
    if (file === undefined) return;
    void file.text().then(setCsv);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Suite settings</T>
          </DialogTitle>
          <DialogDescription>
            <T>Steps and checks keep their order and targets; only their text can change.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">
                <T>Name</T>
              </span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>

            <section className="grid gap-1.5">
              <span className="text-xs font-medium">
                <T>Visual check</T>
              </span>
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  <T>Allowed difference from the baseline, in percent of pixels</T>
                </span>
                <Input
                  inputMode="decimal"
                  value={thresholdPercent}
                  onChange={(event) => setThresholdPercent(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  <T>Masks: selectors for content that changes every run, one per line</T>
                </span>
                <Textarea
                  rows={2}
                  placeholder=".clock"
                  value={masks}
                  onChange={(event) => setMasks(event.target.value)}
                />
              </label>
            </section>

            <section className="grid gap-1.5">
              <span className="text-xs font-medium">
                <T>Data set</T>
              </span>
              <span className="text-xs text-muted-foreground">
                <T>
                  CSV. The first row names parameters; each later row is one replay. Use them as{" "}
                  <code>
                    <Var>{"{{param:name}}"}</Var>
                  </code>{" "}
                  in the texts below.
                </T>
              </span>
              <Textarea
                rows={4}
                // oxlint-disable-next-line t3code/no-untranslated-copy -- sample CSV data, not copy
                placeholder={"name,email\nann,ann@shop.test"}
                value={csv}
                onChange={(event) => setCsv(event.target.value)}
              />
              <label className="text-xs text-muted-foreground">
                <T>Import CSV</T>{" "}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => importCsv(event.target.files?.[0])}
                />
              </label>
            </section>

            {texts.length > 0 ? (
              <section className="grid gap-1.5">
                <span className="text-xs font-medium">
                  <T>Texts</T>
                </span>
                {texts.map((text) => (
                  <label key={text.key} className="grid gap-1">
                    <span className="truncate text-xs text-muted-foreground">{text.label}</span>
                    <Input
                      value={edits.get(text.key) ?? text.value}
                      onChange={(event) =>
                        setEdits(new Map(edits).set(text.key, event.target.value))
                      }
                    />
                  </label>
                ))}
              </section>
            ) : null}

            <section className="grid gap-1.5">
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">
                  <T>Self-healing</T>
                </span>
                <Switch
                  checked={healing}
                  onCheckedChange={setHealing}
                  aria-label={gt("Self-healing")}
                />
              </label>
              <span className="text-xs text-muted-foreground">
                <T>
                  When an element is gone, a short call to this model proposes a new one. You accept
                  or dismiss it; it never adds steps, changes checks or passes a scenario.
                </T>
              </span>
              {healing ? (
                <HealingModel
                  environmentId={props.environmentId}
                  projectId={suite.projectId}
                  selection={healingModel}
                  onChange={setHealingModel}
                />
              ) : null}
            </section>

            {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? gt("Saving…") : gt("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
