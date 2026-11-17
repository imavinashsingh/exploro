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
  readonly selection: ModelSelection;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { selection } = props;
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = useEnvironmentProviders().get(props.environmentId) ?? EMPTY_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId: props.environmentId,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: props.projectId,
    selections: [selection],
  });
  const available = targets.entries.some(
    (entry) => entry.instanceId === selection.instanceId && entry.enabled && entry.isAvailable,
  );
  return (
    <div className="flex flex-col gap-1">
      <ProviderModelPicker
        environmentId={props.environmentId}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={targets.entries}
        modelOptionsByInstance={getTextGenerationModelOptionsByInstance(
          settings,
          targets.providers,
          selection.instanceId,
          selection.model,
        )}
        onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
          props.onChange({ instanceId, model })
        }
      />
      {available ? null : (
        <p className="m-0 text-xs text-warning-foreground">Not available with this provider.</p>
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
  const { suite } = props;
  const defaultModel = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.textGenerationModelSelection,
  );
  const update = useAtomCommand(serverEnvironment.updateQaSuite, {
    label: "update regression suite",
    reportFailure: false,
  });
  const texts = editableTexts(suite);
  const [name, setName] = useState(suite.name);
  const [thresholdPercent, setThresholdPercent] = useState(String(suite.visual.threshold * 100));
  const [masks, setMasks] = useState(suite.visual.masks.join("\n"));
  const [csv, setCsv] = useState(csvFromDataSet(suite.dataSet));
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [healing, setHealing] = useState(suite.healing.enabled);
  const [healingModel, setHealingModel] = useState(
    suite.healing.modelSelection ?? suite.recordedWith ?? defaultModel,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const threshold = Number(thresholdPercent) / 100;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      return setError("The allowed difference is a percentage from 0 to 100.");
    const dataSet = dataSetFromCsv(csv);
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
          modelSelection: healingModel === suite.recordedWith ? null : healingModel,
        },
        ...applyTexts(suite, edits),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save the suite.");
      }
      return;
    }
    toastManager.add({ type: "success", title: `Saved ${result.value.name}` });
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
          <DialogTitle>Suite settings</DialogTitle>
          <DialogDescription>
            Steps and checks keep their order and targets; only their text can change.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>

            <section className="grid gap-1.5">
              <span className="text-xs font-medium">Visual check</span>
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Allowed difference from the baseline, in percent of pixels
                </span>
                <Input
                  inputMode="decimal"
                  value={thresholdPercent}
                  onChange={(event) => setThresholdPercent(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Masks: selectors for content that changes every run, one per line
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
              <span className="text-xs font-medium">Data set</span>
              <span className="text-xs text-muted-foreground">
                CSV. The first row names parameters; each later row is one replay. Use them as{" "}
                <code>{"{{param:name}}"}</code> in the texts below.
              </span>
              <Textarea
                rows={4}
                placeholder={"name,email\nann,ann@shop.test"}
                value={csv}
                onChange={(event) => setCsv(event.target.value)}
              />
              <label className="text-xs text-muted-foreground">
                Import CSV{" "}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => importCsv(event.target.files?.[0])}
                />
              </label>
            </section>

            {texts.length > 0 ? (
              <section className="grid gap-1.5">
                <span className="text-xs font-medium">Texts</span>
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
                <span className="text-xs font-medium">Self-healing</span>
                <Switch checked={healing} onCheckedChange={setHealing} aria-label="Self-healing" />
              </label>
              <span className="text-xs text-muted-foreground">
                When an element is gone, a short call to this model proposes a new one. You accept
                or dismiss it; it never adds steps, changes checks or passes a scenario.
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
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
