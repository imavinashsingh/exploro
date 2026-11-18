import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface MemoryEmbedderStatus {
  readonly model: string | null;
  /** Why semantic recall is off; null while a model is loaded. */
  readonly unavailableReason: string | null;
}

/** Turns understanding statements into vectors for recall by meaning. */
export class MemoryEmbedder extends Context.Service<
  MemoryEmbedder,
  {
    readonly status: Effect.Effect<MemoryEmbedderStatus>;
    /** One unit vector per text, or null when no model is loaded; recall then uses text search. */
    readonly embed: (
      texts: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Float32Array> | null>;
  }
>()("t3/memory/MemoryEmbedder") {}

export const layerUnavailable = Layer.succeed(
  MemoryEmbedder,
  MemoryEmbedder.of({
    status: Effect.succeed({
      model: null,
      unavailableReason: "No embedding model is loaded, so recall uses text search only.",
    }),
    embed: Effect.fn("MemoryEmbedder.embed")(() => Effect.succeed(null)),
  }),
);
