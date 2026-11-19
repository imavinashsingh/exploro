import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, QaSavedSecret } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportQaFailure } from "../chat/ThreadDetailsRegression";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/** Passwords the project's suites sign in with, and the way to forget one. */
export function ProjectPasswordsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly savedSecrets: ReadonlyArray<QaSavedSecret>;
}) {
  const gt = useGT();
  const canForget = useAtomValue(
    serverEnvironment.forgetQaSavedSecret.permissionAtom(props.environmentId),
  );
  const forgetSecret = useAtomCommand(serverEnvironment.forgetQaSavedSecret, {
    label: "remove saved password",
    reportFailure: false,
  });
  const [confirmForget, setConfirmForget] = useState<QaSavedSecret | null>(null);

  if (props.savedSecrets.length === 0)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>No saved passwords. A suite saves one when a test signs in and you choose to keep it.</T>
      </p>
    );

  const forget = async (secret: QaSavedSecret) => {
    setConfirmForget(null);
    const result = await forgetSecret({
      environmentId: props.environmentId,
      input: { secretId: secret.secretId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportQaFailure(gt("Could not remove the saved password"), squashAtomCommandFailure(result));
  };

  return (
    <div className="p-3">
      <ul className="m-0 flex list-none flex-col p-0">
        {props.savedSecrets.map((secret) => (
          <li
            key={secret.secretId}
            className="flex min-w-0 items-center gap-2 border-b border-border/65 py-2 last:border-b-0"
          >
            <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{secret.label}</span>
              <span className="truncate text-xs text-muted-foreground">
                {secret.site === null ? gt("Any site") : new URL(secret.site).host}
              </span>
            </span>
            {canForget ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Remove saved password {label}", { label: secret.label })}
                onClick={() => setConfirmForget(secret)}
              >
                <Trash2Icon aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <AlertDialog
        open={confirmForget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmForget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Remove this saved password?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Regression suites that sign in with it stop at that step until you save it again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => confirmForget && void forget(confirmForget)}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
