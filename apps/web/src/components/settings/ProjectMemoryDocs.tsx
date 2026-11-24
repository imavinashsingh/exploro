import {
  memoryDocsInOrder,
  memoryGuideSlug,
  proposalChangesConfirmed,
} from "@t3tools/client-runtime/state/projectMemory";
import type { MemoryDoc, MemoryProposal, ProjectMemoryFact } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** What the editor saves; the playbook and every guide are confirmed once the user saves them. */
export interface MemoryDocDraft {
  readonly kind: MemoryDoc["kind"];
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly environment: string | null;
  readonly routes: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
  readonly body: string;
}

const splitLines = (text: string) =>
  [...new Set(text.split(/[\n,]/u).map((line) => line.trim()))].filter((line) => line !== "");

function DocEditor(props: {
  readonly initial: MemoryDocDraft;
  readonly isNew: boolean;
  readonly takenSlugs: ReadonlySet<string>;
  readonly onSave: (draft: MemoryDocDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const [title, setTitle] = useState(props.initial.title);
  const [summary, setSummary] = useState(props.initial.summary);
  const [routes, setRoutes] = useState(props.initial.routes.join("\n"));
  const [body, setBody] = useState(props.initial.body);
  const [saving, setSaving] = useState(false);
  const slug =
    props.isNew && props.initial.kind === "guide" ? memoryGuideSlug(title) : props.initial.slug;
  const taken = props.isNew && props.takenSlugs.has(slug);
  return (
    <form
      className="flex flex-col gap-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void props
          .onSave({
            ...props.initial,
            slug,
            title: title.trim(),
            summary: summary.trim(),
            routes: splitLines(routes),
            body,
          })
          .then((saved) => {
            setSaving(false);
            if (saved) props.onCancel();
          });
      }}
    >
      <Input
        aria-label={gt("Title")}
        placeholder={gt("Title")}
        value={title}
        maxLength={300}
        required
        onChange={(event) => setTitle(event.target.value)}
      />
      <Input
        aria-label={gt("Summary")}
        placeholder={gt("One line on what this covers")}
        value={summary}
        maxLength={1000}
        onChange={(event) => setSummary(event.target.value)}
      />
      {props.initial.kind === "guide" ? (
        <Textarea
          aria-label={gt("Routes")}
          placeholder={gt("Routes it applies to, one per line, such as /checkout")}
          value={routes}
          onChange={(event) => setRoutes(event.target.value)}
        />
      ) : null}
      <Textarea
        aria-label={gt("Markdown")}
        className="min-h-40"
        value={body}
        maxLength={100_000}
        onChange={(event) => setBody(event.target.value)}
      />
      {taken ? (
        <p className="m-0 text-xs text-destructive">
          <T>A guide with this name exists. Edit that guide or choose another title.</T>
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={saving || taken || title.trim() === ""}>
          {saving ? gt("Saving…") : gt("Save")}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}

const draftOf = (doc: MemoryDoc): MemoryDocDraft => ({
  kind: doc.kind,
  slug: doc.slug,
  title: doc.title,
  summary: doc.summary,
  environment: doc.environment ?? null,
  routes: doc.routes,
  keywords: doc.keywords,
  body: doc.body,
});

const NEW_GUIDE: MemoryDocDraft = {
  kind: "guide",
  slug: "",
  title: "",
  summary: "",
  environment: null,
  routes: [],
  keywords: [],
  body: "",
};

/** The playbook and guides agents follow; saving one makes it the user's confirmed version. */
export function MemoryDocsTab(props: {
  readonly docs: ReadonlyArray<MemoryDoc>;
  readonly canEdit: boolean;
  readonly onSave: (draft: MemoryDocDraft) => Promise<boolean>;
}) {
  const gt = useGT();
  const [editing, setEditing] = useState<string | null>(null);
  const docs = memoryDocsInOrder(props.docs);
  const takenSlugs = new Set(docs.filter((doc) => doc.kind === "guide").map((doc) => doc.slug));
  const hasPlaybook = docs.some((doc) => doc.kind === "playbook");
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-muted-foreground">
        <T>
          Agents read these before testing. Saving makes a document confirmed, so agents can only
          suggest changes to it.
        </T>
      </p>
      <div className="flex flex-wrap gap-2">
        {hasPlaybook ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={!props.canEdit || editing !== null}
            onClick={() => setEditing("new:playbook")}
          >
            <T>Write the playbook</T>
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canEdit || editing !== null}
          onClick={() => setEditing("new:guide")}
        >
          <T>New guide</T>
        </Button>
      </div>
      {editing === "new:playbook" || editing === "new:guide" ? (
        <DocEditor
          initial={
            editing === "new:playbook"
              ? {
                  ...NEW_GUIDE,
                  kind: "playbook",
                  slug: "playbook",
                  title: gt("Project playbook"),
                  summary: gt("How this project is tested"),
                }
              : NEW_GUIDE
          }
          isNew
          takenSlugs={takenSlugs}
          onSave={props.onSave}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {docs.length === 0 && editing === null ? (
        <p className="py-2 text-sm text-muted-foreground">
          <T>No playbook or guides yet. Approve a proposal or write one.</T>
        </p>
      ) : null}
      <ul className="flex flex-col">
        {docs.map((doc) => (
          <li
            key={doc.docId}
            className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0"
          >
            {editing === doc.docId ? (
              <DocEditor
                initial={draftOf(doc)}
                isNew={false}
                takenSlugs={takenSlugs}
                onSave={props.onSave}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{doc.title}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
                      <Badge variant={doc.status === "confirmed" ? "success" : "outline"}>
                        {doc.status === "confirmed" ? gt("confirmed") : gt("draft")}
                      </Badge>
                      <span>{doc.kind === "playbook" ? gt("Playbook") : gt("Guide")}</span>
                      {doc.routes.length > 0 ? <span>{doc.routes.join(", ")}</span> : null}
                      {doc.environment === undefined ? null : <span>{doc.environment}</span>}
                      <span>{doc.updatedAt.slice(0, 10)}</span>
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!props.canEdit || editing !== null}
                    onClick={() => setEditing(doc.docId)}
                  >
                    <T>Edit</T>
                  </Button>
                </div>
                {doc.summary === "" ? null : (
                  <p className="m-0 text-xs text-muted-foreground">{doc.summary}</p>
                )}
                <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
                  {doc.body}
                </pre>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Drafts finished runs suggested; nothing reaches the playbook or guides until approved. */
export function MemoryProposalsTab(props: {
  readonly proposals: ReadonlyArray<MemoryProposal>;
  readonly docs: ReadonlyArray<MemoryDoc>;
  readonly canEdit: boolean;
  readonly onApprove: (proposal: MemoryProposal, replaceConfirmed: boolean) => Promise<boolean>;
  readonly onDismiss: (proposal: MemoryProposal) => Promise<boolean>;
}) {
  const gt = useGT();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = (proposal: MemoryProposal, run: () => Promise<boolean>) => {
    setBusy(proposal.proposalId);
    void run().then(() => setBusy(null));
  };
  if (props.proposals.length === 0)
    return (
      <p className="py-2 text-sm text-muted-foreground">
        <T>Nothing to review. Finished test runs suggest playbook and guide changes here.</T>
      </p>
    );
  return (
    <ul className="flex flex-col">
      {props.proposals.map((proposal) => {
        const changesConfirmed = proposalChangesConfirmed(proposal, props.docs);
        const disabled = !props.canEdit || busy !== null;
        return (
          <li
            key={proposal.proposalId}
            className="flex flex-col gap-1.5 border-b border-border/60 py-2 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="m-0 min-w-0 break-words text-sm font-medium">{proposal.title}</p>
              <Badge variant="outline">
                {proposal.kind === "playbook" ? gt("Playbook") : gt("Guide")}
              </Badge>
              {changesConfirmed ? (
                <Badge variant="warning">{gt("Changes a confirmed document")}</Badge>
              ) : null}
            </div>
            <p className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {proposal.rationale}
            </p>
            <div>
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={open === proposal.proposalId}
                onClick={() => setOpen(open === proposal.proposalId ? null : proposal.proposalId)}
              >
                {open === proposal.proposalId ? gt("Hide Markdown") : gt("Show Markdown")}
              </Button>
            </div>
            {open === proposal.proposalId ? (
              <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
                {proposal.proposedMarkdown}
              </pre>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {changesConfirmed ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => act(proposal, () => props.onApprove(proposal, true))}
                >
                  <T>Approve and change confirmed</T>
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={disabled}
                  onClick={() => act(proposal, () => props.onApprove(proposal, false))}
                >
                  <T>Approve</T>
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => act(proposal, () => props.onDismiss(proposal))}
              >
                <T>Dismiss</T>
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** FAIL results from recent runs: defects to re-check, never rules for the playbook. */
export function MemoryOpenIssuesList(props: { readonly issues: ReadonlyArray<ProjectMemoryFact> }) {
  if (props.issues.length === 0)
    return (
      <p className="py-2 text-sm text-muted-foreground">
        <T>No open issues. Failed checks from finished runs show up here.</T>
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-muted-foreground">
        <T>
          Failures seen in recent runs. They are not rules for the playbook or guides: re-check one
          before reporting it.
        </T>
      </p>
      <ul className="flex flex-col">
        {props.issues.map((fact) => (
          <li
            key={fact.factId}
            className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-b-0"
          >
            <p className="m-0 break-words text-sm">{fact.key}</p>
            <p className="m-0 break-words text-xs text-muted-foreground">
              {fact.stateName} · {fact.environment}
              {fact.route} · {fact.observedAt.slice(0, 10)}
            </p>
            {fact.detail === null ? null : (
              <p className="m-0 break-words text-xs text-muted-foreground">{fact.detail}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
