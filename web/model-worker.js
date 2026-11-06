import { env, AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

export const MODEL = 'Xenova/clip-vit-base-patch32';
export const REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let textComponents;
let visionComponents;

function options(id) {
  return {
    revision: REVISION, device: 'wasm', dtype: 'q8',
    progress_callback: (progress) => {
      if (progress.status === 'progress') self.postMessage({ id, progress: { file: progress.file, value: progress.progress } });
    },
  };
}

function normalized(tensor) {
  const vector = Array.from(tensor.data);
  const norm = Math.hypot(...vector);
  if (vector.length !== 512 || !Number.isFinite(norm) || norm === 0) throw new Error('The image model returned an invalid embedding.');
  return vector.map(value => value / norm);
}

self.onmessage = async ({ data: { id, type, input } }) => {
  try {
    let vector;
    if (type === 'text') {
      if (!textComponents) textComponents = Promise.all([
        AutoTokenizer.from_pretrained(MODEL, { revision: REVISION }),
        CLIPTextModelWithProjection.from_pretrained(MODEL, options(id)),
      ]).catch(error => { textComponents = null; throw error; });
      const [tokenizer, model] = await textComponents;
      const output = await model(tokenizer(input, { padding: true, truncation: true }));
      vector = normalized(output.text_embeds);
    } else if (type === 'image') {
      if (!visionComponents) visionComponents = Promise.all([
        AutoProcessor.from_pretrained(MODEL, { revision: REVISION }),
        CLIPVisionModelWithProjection.from_pretrained(MODEL, options(id)),
      ]).catch(error => { visionComponents = null; throw error; });
      const [processor, model] = await visionComponents;
      const image = await RawImage.read(input);
      const output = await model(await processor(image));
      vector = normalized(output.image_embeds);
    } else throw new Error('Unknown embedding request.');
    self.postMessage({ id, vector });
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
