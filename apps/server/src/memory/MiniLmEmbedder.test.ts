import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { MemoryEmbedder } from "./MemoryEmbedder.ts";
import * as MiniLmEmbedder from "./MiniLmEmbedder.ts";

it.layer(NodeServices.layer)("MiniLmEmbedder", (it) => {
  it.effect("falls back to text search and says why when no model is bundled", () =>
    Effect.gen(function* () {
      const empty = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const embedder = yield* MemoryEmbedder.pipe(
        Effect.provide(MiniLmEmbedder.layerFrom([empty])),
      );
      const status = yield* embedder.status;
      assert.isNull(status.model);
      assert.include(status.unavailableReason, "fetch-memory-model");
      assert.isNull(yield* embedder.embed(["Checkout needs a saved card"]));
      assert.deepStrictEqual(yield* embedder.embed([]), []);
    }),
  );

  it("averages only the tokens the mask keeps and returns unit vectors", () => {
    // Two rows of three tokens with two dimensions; the second row's last token is padding.
    const output = Float32Array.from([3, 0, 0, 4, 3, 4, 2, 0, 0, 2, 100, 100]);
    const [first, second] = MiniLmEmbedder.poolAndNormalize(
      output,
      [
        [1, 1, 1],
        [1, 1, 0],
      ],
      3,
      2,
    );
    assert.deepStrictEqual(
      [...first!].map((value) => value.toFixed(3)),
      ["0.600", "0.800"],
    );
    assert.deepStrictEqual(
      [...second!].map((value) => value.toFixed(3)),
      ["0.707", "0.707"],
    );
  });
});
