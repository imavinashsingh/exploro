import {
  QaRunError,
  QaSavedSecret,
  type ProjectId,
  type QaSavedSecretId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

/** Passwords the user chose to keep for a project's regression suites. */
export class QaSavedSecrets extends Context.Service<
  QaSavedSecrets,
  {
    /** Keeps the value; the same project, label and site replace the earlier value under its id. */
    readonly remember: (input: {
      readonly projectId: ProjectId;
      readonly label: string;
      readonly site: string | null;
      readonly value: string;
    }) => Effect.Effect<QaSavedSecretId, QaRunError>;
    /** The value, only for the project it was saved in. */
    readonly read: (
      projectId: ProjectId,
      secretId: QaSavedSecretId,
    ) => Effect.Effect<Option.Option<string>, QaRunError>;
    readonly list: Effect.Effect<ReadonlyArray<QaSavedSecret>, QaRunError>;
    readonly forget: (secretId: QaSavedSecretId) => Effect.Effect<void, QaRunError>;
    readonly changes: Stream.Stream<void>;
  }
>()("t3/qa/QaSavedSecrets") {}

const IndexJson = Schema.fromJsonString(Schema.Array(QaSavedSecret));
const decodeIndex = Schema.decodeUnknownOption(IndexJson);
const encodeIndex = Schema.encodeEffect(IndexJson);
const failure = (message: string) => (cause: unknown) => new QaRunError({ message, cause });
const storeName = (secretId: QaSavedSecretId) => secretId;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const changes = yield* PubSub.unbounded<void>();
  const lock = yield* Semaphore.make(1);
  // The index holds labels only; values stay in the secret store.
  const indexPath = path.join(config.stateDir, "qa-saved-secrets.json");

  const load = fileSystem.readFileString(indexPath).pipe(
    Effect.map((text) => Option.getOrElse(decodeIndex(text), () => [])),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([] as ReadonlyArray<QaSavedSecret>),
    ),
    Effect.mapError(failure("Could not read the saved passwords.")),
  );

  const save = (entries: ReadonlyArray<QaSavedSecret>) =>
    encodeIndex(entries).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: indexPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(failure("Could not save the saved passwords.")),
    );

  const remember: QaSavedSecrets["Service"]["remember"] = Effect.fn("QaSavedSecrets.remember")(
    function* (input) {
      const savedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const secretId = yield* lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* load;
          const existing = entries.find(
            (entry) =>
              entry.projectId === input.projectId &&
              entry.label === input.label &&
              entry.site === input.site,
          );
          const secretId =
            existing?.secretId ??
            (`qa-secret-${Hex.encode(yield* random.randomBytes(12))}` as QaSavedSecretId);
          yield* store
            .set(storeName(secretId), new TextEncoder().encode(input.value))
            .pipe(Effect.mapError(failure("Could not save the password.")));
          const entry: QaSavedSecret = {
            secretId,
            projectId: input.projectId,
            label: input.label,
            site: input.site,
            savedAt,
          };
          yield* save([entry, ...entries.filter((other) => other.secretId !== secretId)]);
          return secretId;
        }),
      );
      yield* PubSub.publish(changes, undefined);
      return secretId;
    },
  );

  const read: QaSavedSecrets["Service"]["read"] = Effect.fn("QaSavedSecrets.read")(
    function* (projectId, secretId) {
      const entry = (yield* load).find((candidate) => candidate.secretId === secretId);
      if (entry === undefined || entry.projectId !== projectId) return Option.none();
      const bytes = yield* store
        .get(storeName(secretId))
        .pipe(Effect.mapError(failure("Could not read the saved password.")));
      return Option.map(bytes, (value) => new TextDecoder().decode(value));
    },
  );

  const forget: QaSavedSecrets["Service"]["forget"] = Effect.fn("QaSavedSecrets.forget")(
    function* (secretId) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          // Value first: a failed index write leaves a label with nothing behind it, never the reverse.
          yield* store
            .remove(storeName(secretId))
            .pipe(Effect.mapError(failure("Could not remove the saved password.")));
          yield* save((yield* load).filter((entry) => entry.secretId !== secretId));
        }),
      );
      yield* PubSub.publish(changes, undefined);
    },
  );

  return QaSavedSecrets.of({
    remember,
    read,
    list: load,
    forget,
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(QaSavedSecrets, make);
