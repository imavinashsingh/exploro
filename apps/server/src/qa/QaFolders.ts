import { QaRunError, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";

/** The folder in a project that holds all of its QA data. */
export const QA_PROJECT_DIR = "qa-runs";
export const QA_SUITES_DIR = "suites";

export interface QaProject {
  readonly projectId: ProjectId;
  readonly root: string;
}

export class QaFolders extends Context.Service<
  QaFolders,
  {
    /** The project a thread's QA data belongs in; null for threads without a project. */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<(QaProject & { readonly threadTitle: string }) | null, QaRunError>;
    readonly forProject: (projectId: ProjectId) => Effect.Effect<QaProject | null, QaRunError>;
    readonly projects: Effect.Effect<ReadonlyArray<QaProject>, QaRunError>;
  }
>()("t3/qa/QaFolders") {}

const unavailable = (cause: unknown) =>
  new QaRunError({ message: "Could not find the QA project folder.", cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;

  // "No project" threads live in the scratch project, which holds no QA data.
  const forProject = Effect.fn("QaFolders.forProject")(function* (projectId: ProjectId) {
    if (yield* managedFolders.isScratchProject(projectId)) return null;
    const project = yield* projectService.getById(projectId);
    return Option.isNone(project) ? null : { projectId, root: project.value.workspaceRoot };
  }, Effect.mapError(unavailable));

  return QaFolders.of({
    forProject,
    forThread: Effect.fn("QaFolders.forThread")(function* (threadId) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (shell === null) return null;
      const project = yield* forProject(shell.projectId);
      return project === null ? null : { ...project, threadTitle: shell.title };
    }),
    projects: projectService.listShells().pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(Effect.forEach((shell) => forProject(shell.id))),
      Effect.map((found) => found.filter((project) => project !== null)),
    ),
  });
});

export const layer = Layer.effect(QaFolders, make);

/**
 * The agent can write in a project, so a QA path must reach its target without any link between
 * `base` and it. Fails for a path outside `base` too.
 */
export const checkInside = Effect.fn("QaFolders.checkInside")(function* (
  base: string,
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refused = new QaRunError({
    message: `${target} is a link or leads outside ${base}, so Exploro left it alone.`,
  });
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return yield* refused;
  const realBase = yield* fileSystem.realPath(base).pipe(Effect.mapError(() => refused));
  let current = realBase;
  for (const segment of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    const real = yield* fileSystem.realPath(current).pipe(Effect.option);
    if (Option.isSome(real)) {
      if (path.relative(current, real.value) !== "") return yield* refused;
    } else if (Option.isSome(yield* fileSystem.readLink(current).pipe(Effect.option))) {
      // A dangling link would send a write wherever it points.
      return yield* refused;
    }
  }
});

/**
 * Where a run or suite folder is anchored: both `<project>/qa-runs/<name>` and
 * `<state>/qa-runs/<thread>/<run>` sit two levels below it.
 */
export const baseOf = (path: Path.Path, folder: string) => path.dirname(path.dirname(folder));

/** `2026-11-28_0017_login-credential-testing`, in the server's local time. */
export function runFolderName(startedAtMillis: number, title: string): string {
  const parts = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(startedAtMillis), DateTime.zoneMakeLocal()),
  );
  const two = (value: number) => String(value).padStart(2, "0");
  const slug = title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}_${two(parts.hour)}${two(parts.minute)}_${slug || "qa-run"}`;
}

const inGitRepository = Effect.fnUntraced(function* (folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    if (yield* fileSystem.exists(path.join(current, ".git"))) return true;
    if (path.dirname(current) === current) return false;
  }
});

/**
 * The project's QA folder, created if needed. A project that is still in a Git repository gets an
 * ignore file, so videos are not snapshotted into every checkpoint.
 */
export const ensureQaRoot = Effect.fn("QaFolders.ensureQaRoot")(function* (projectRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A project folder deleted by hand is not recreated.
  if (!(yield* fileSystem.exists(projectRoot)))
    return yield* new QaRunError({ message: `The project folder ${projectRoot} is missing.` });
  const qaRoot = path.join(projectRoot, QA_PROJECT_DIR);
  yield* checkInside(projectRoot, qaRoot);
  yield* fileSystem.makeDirectory(qaRoot, { recursive: true });
  if (yield* inGitRepository(projectRoot)) {
    const ignorePath = path.join(qaRoot, ".gitignore");
    if (!(yield* fileSystem.exists(ignorePath))) {
      yield* checkInside(projectRoot, ignorePath);
      yield* fileSystem.writeFileString(ignorePath, "*\n");
    }
  }
  return qaRoot;
});

const listFiles = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<{ readonly name: string; readonly size: string }> = [];
  for (const name of yield* fileSystem.readDirectory(root, { recursive: true })) {
    const info = yield* fileSystem.stat(path.join(root, name));
    if (info.type === "File") files.push({ name, size: String(info.size) });
  }
  return files;
});

/** Whether every file under `source` is also under `target`, with the same size. */
export const isCopyOf = Effect.fn("QaFolders.isCopyOf")(function* (source: string, target: string) {
  const copied = new Map((yield* listFiles(target)).map((file) => [file.name, file.size]));
  return (yield* listFiles(source)).every((file) => copied.get(file.name) === file.size);
});

/** Copies a folder into place as a whole, checking every file arrived. The source stays. */
export const copyFolder = Effect.fn("QaFolders.copyFolder")(function* (
  source: string,
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const partial = `${target}.partial`;
  yield* fileSystem.remove(partial, { recursive: true, force: true });
  yield* fileSystem.copy(source, partial);
  if (!(yield* isCopyOf(source, partial)))
    return yield* new QaRunError({ message: `The copy of ${source} is incomplete.` });
  yield* fileSystem.rename(partial, target);
});
