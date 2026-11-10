import {
  env,
  AutoTokenizer,
  AutoModel
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let encoder;

function options(id, revision, dtype = 'q8') {
  return {
    revision,
    dtype,
    device: 'wasm',
    progress_callback: progress => {
      if (progress.status === 'progress') self.postMessage({
        id,
        progress: Math.round(progress.progress),
        file: progress.file
      });
    }
  };
}

self.onmessage = async ({
  data: {
    id,
    type,
    input
  }
}) => {
  try {
    const started = performance.now();
    if (type === 'embed') {
      if (!encoder) encoder = Promise.all([
        AutoTokenizer.from_pretrained('Xenova/all-MiniLM-L6-v2', {
          revision: '751bff37182d3f1213fa05d7196b954e230abad9'
        }),
        AutoModel.from_pretrained('Xenova/all-MiniLM-L6-v2', options(id, '751bff37182d3f1213fa05d7196b954e230abad9')),
      ]).catch(error => {
        encoder = null;
        throw error;
      });
      const [tokenizer, model] = await encoder;
      const inputs = tokenizer(input, {
        padding: true,
        truncation: true,
        max_length: 256
      });
      // Keep BERT's final separator when Transformers.js truncates a long input.
      // The offline Hugging Face tokenizer reserves this slot automatically.
      if (inputs.input_ids.data.length === 256) {
        const separator = tokenizer.sep_token_id ?? 102;
        inputs.input_ids.data[255] = typeof inputs.input_ids.data[255] === 'bigint' ? BigInt(separator) : separator;
      }
      const output = await model(inputs);
      const hidden = output.last_hidden_state,
        mask = inputs.attention_mask.data;
      const dimensions = hidden.dims[2],
        vector = new Array(dimensions).fill(0);
      let count = 0;
      for (let token = 0; token < hidden.dims[1]; token++) {
        if (!Number(mask[token])) continue;
        count++;
        for (let dimension = 0; dimension < dimensions; dimension++) vector[dimension] += hidden.data[token * dimensions + dimension];
      }
      if (dimensions !== 384 || !count) throw new Error('The text encoder returned an invalid embedding.');
      for (let dimension = 0; dimension < dimensions; dimension++) vector[dimension] /= count;
      const norm = Math.hypot(...vector);
      let signature = 2166136261;
      for (const token of inputs.input_ids.data) signature = Math.imul(signature ^ Number(token), 16777619) >>> 0;
      self.postMessage({
        id,
        vector: vector.map(value => value / norm),
        inputTokens: inputs.input_ids.data.length,
        tokenSignature: signature.toString(16).padStart(8, '0'),
        ms: performance.now() - started
      });
    } else throw new Error('Unknown model request.');
  } catch (error) {
    self.postMessage({
      id,
      error: error.message || String(error)
    });
  }
};