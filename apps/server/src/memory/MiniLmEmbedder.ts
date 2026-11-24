import { Tokenizer } from "@huggingface/tokenizers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ort from "onnxruntime-web/wasm";
import * as NodeURL from "node:url";

import { MemoryEmbedder } from "./MemoryEmbedder.ts";
import {
  MEMORY_MODEL_FETCH_HINT,
  MEMORY_MODEL_FILES,
  MEMORY_MODEL_FOLDER,
  MEMORY_MODEL_NAME,
  MEMORY_RUNTIME_FILES,
} from "./memoryModel.ts";

class MemoryEmbedderError extends Schema.TaggedError<MemoryEmbedderError>()("MemoryEmbedderError", {
  cause: Schema.Defect(),
}) {}
const embedderError = (cause: unknown) => new MemoryEmbedderError({ cause });
const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// MiniLM was trained on 256 tokens; longer inputs only add cost.
const MAX_TOKENS = 256;
const BATCH_SIZE = 16;

interface LoadedModel {
  readonly session: ort.InferenceSession;
  readonly tokenizer: Tokenizer;
}

/** Mean of the token vectors the mask keeps, scaled to unit length. */
export function poolAndNormalize(
  output: Float32Array,
  masks: ReadonlyArray<ReadonlyArray<number>>,
  sequenceLength: number,
  dimensions: number,
): ReadonlyArray<Float32Array> {
  return masks.map((mask, row) => {
    const vector = new Float32Array(dimensions);
    let tokens = 0;
    for (let position = 0; position < sequenceLength; position += 1) {
      if (mask[position] !== 1) continue;
      tokens += 1;
      const offset = (row * sequenceLength + position) * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        vector[dimension]! += output[offset + dimension]!;
      }
    }
    const mean = vector.map((value) => value / Math.max(tokens, 1));
    const length = Math.hypot(...mean) || 1;
    return mean.map((value) => value / length);
  });
}

const make = Effect.fnUntraced(function* (folders?: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Beside the server bundle (dist, the CLI archive), or the source checkout's fetched copy.
  const candidates = folders ?? [
    path.join(import.meta.dirname, MEMORY_MODEL_FOLDER),
    path.resolve(import.meta.dirname, "../..", MEMORY_MODEL_FOLDER),
  ];
  const required = [...MEMORY_MODEL_FILES.map((file) => file.name), ...MEMORY_RUNTIME_FILES];
  const directory = yield* Effect.findFirst(candidates, (candidate) =>
    Effect.forEach(required, (name) => fs.exists(path.join(candidate, name))).pipe(
      Effect.map((found) => found.every(Boolean)),
      Effect.orElseSucceed(() => false),
    ),
  );
  const unavailable = yield* Ref.make<string | null>(
    directory._tag === "None"
      ? `No embedding model is bundled, so recall uses text search only. ${MEMORY_MODEL_FETCH_HINT}`
      : null,
  );

  const load = yield* Effect.cached(
    Effect.gen(function* () {
      if (directory._tag === "None") return yield* embedderError("missing");
      const dir = directory.value;
      const readJson = (name: string) =>
        fs.readFileString(path.join(dir, name)).pipe(Effect.flatMap(decodeJsonObject));
      const tokenizer = new Tokenizer(
        yield* readJson("tokenizer.json"),
        yield* readJson("tokenizer_config.json"),
      );
      const bytes = yield* fs.readFile(path.join(dir, "model_quantized.onnx"));
      // Worker threads need a browser; one thread keeps the WASM backend on Node.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = NodeURL.pathToFileURL(`${dir}${path.sep}`).href;
      const session = yield* Effect.tryPromise({
        try: () => ort.InferenceSession.create(bytes),
        catch: embedderError,
      });
      return { session, tokenizer } satisfies LoadedModel;
    }).pipe(
      Effect.tapCause((cause) =>
        directory._tag === "None"
          ? Effect.void
          : Effect.logWarning("Project memory embedding model did not load", { cause }).pipe(
              Effect.andThen(
                Ref.set(
                  unavailable,
                  "The embedding model could not load, so recall uses text search only.",
                ),
              ),
            ),
      ),
    ),
  );

  const embedBatch = Effect.fnUntraced(function* (
    { session, tokenizer }: LoadedModel,
    texts: ReadonlyArray<string>,
  ) {
    const encoded = texts.map((text) => {
      const ids: ReadonlyArray<number> = tokenizer.encode(text).ids;
      // Keep the closing [SEP] when cutting a long text.
      return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), ids.at(-1)!];
    });
    const length = Math.max(...encoded.map((ids) => ids.length));
    const ids = new BigInt64Array(texts.length * length);
    const mask = new BigInt64Array(texts.length * length);
    const masks = encoded.map((row, index) => {
      row.forEach((id, position) => {
        ids[index * length + position] = BigInt(id);
        mask[index * length + position] = 1n;
      });
      return Array.from({ length }, (_, position) => (position < row.length ? 1 : 0));
    });
    const shape = [texts.length, length];
    const outputs = yield* Effect.tryPromise({
      try: () =>
        session.run({
          input_ids: new ort.Tensor("int64", ids, shape),
          attention_mask: new ort.Tensor("int64", mask, shape),
          token_type_ids: new ort.Tensor("int64", new BigInt64Array(ids.length), shape),
        }),
      catch: embedderError,
    });
    const output = outputs[session.outputNames[0]!]!;
    return poolAndNormalize(output.data as Float32Array, masks, length, output.dims[2]!);
  });

  return MemoryEmbedder.of({
    status: Ref.get(unavailable).pipe(
      Effect.map((reason) => ({
        model: reason === null ? MEMORY_MODEL_NAME : null,
        unavailableReason: reason,
      })),
    ),
    embed: Effect.fn("MemoryEmbedder.embed")(function* (texts) {
      if (texts.length === 0) return [];
      const model = yield* Effect.option(load);
      if (model._tag === "None") return null;
      const batches: Array<ReadonlyArray<string>> = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        batches.push(texts.slice(start, start + BATCH_SIZE));
      }
      return yield* Effect.forEach(batches, (batch) => embedBatch(model.value, batch)).pipe(
        Effect.map((vectors) => vectors.flat()),
        Effect.catchCause((cause) =>
          Effect.logWarning("Project memory embedding failed", { cause }).pipe(Effect.as(null)),
        ),
      );
    }),
  });
});

/** The same embedder looking for the model only in `folders`. */
export const layerFrom = (folders: ReadonlyArray<string>) =>
  Layer.effect(MemoryEmbedder, make(folders));
