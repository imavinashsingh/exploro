/**
 * The embedding model project memory bundles for recall by meaning: quantized all-MiniLM-L6-v2
 * run on onnxruntime-web's WASM backend, so it works offline with no native addon.
 */
const MEMORY_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MEMORY_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
/** Stored beside each vector; vectors from another model are embedded again. */
export const MEMORY_MODEL_NAME = `all-MiniLM-L6-v2-q8@${MEMORY_MODEL_REVISION.slice(0, 8)}`;

export const MEMORY_MODEL_FILES = [
  {
    name: "model_quantized.onnx",
    source: "onnx/model_quantized.onnx",
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  },
  {
    name: "tokenizer.json",
    source: "tokenizer.json",
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  },
  {
    name: "tokenizer_config.json",
    source: "tokenizer_config.json",
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  },
] as const;

export const memoryModelUrl = (source: string) =>
  `https://huggingface.co/${MEMORY_MODEL_ID}/resolve/${MEMORY_MODEL_REVISION}/${source}`;

/** onnxruntime-web loads these from the model folder instead of from its package. */
export const MEMORY_RUNTIME_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
] as const;

export const MEMORY_MODEL_FOLDER = "memory-model";

export const MEMORY_MODEL_FETCH_HINT =
  "Run `node apps/server/scripts/cli.ts fetch-memory-model` to add it to a source checkout.";
