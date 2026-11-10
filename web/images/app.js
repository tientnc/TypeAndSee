import { readAll, write } from './store.js';

const $ = id => document.getElementById(id);
const MODEL_REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523-q8';
let orama, database, records = [], worker, requestId = 0, busy = false;
const pending = new Map();
let imageUrls = [];

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function setBusy(value) {
  busy = value;
  $('search-button').disabled = value;
  $('files').disabled = value;
  $('reset').disabled = value;
  document.querySelectorAll('[data-query]').forEach(button => button.disabled = value);
  $('progress').hidden = !value;
  if (!value) $('progress').removeAttribute('value');
}

export function embed(type, input) {
  if (!worker) {
    worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.progress) {
        $('progress').max = 100;
        $('progress').value = data.progress.value;
        status(`Downloading model: ${Math.round(data.progress.value)}%. This may take a minute the first time.`);
        return;
      }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      data.error ? request.reject(new Error(data.error)) : request.resolve(data.vector);
    };
    worker.onerror = () => {
      for (const request of pending.values()) request.reject(new Error('Could not load the browser model. Check your connection or content blocker, then retry.'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, input });
  });
}

function validVector(vector) {
  return Array.isArray(vector) && vector.length === 512 && vector.every(Number.isFinite);
}

async function rebuild() {
  database = await orama.create({ schema: { name: 'string', caption: 'string', embedding: 'vector[512]' } });
  for (const record of records) {
    if (!validVector(record.vector) || record.model !== MODEL_REVISION) continue;
    await orama.insert(database, { id: record.id, name: record.name, caption: record.caption || '', embedding: record.vector });
  }
  $('count').textContent = `${records.length} image${records.length === 1 ? '' : 's'}`;
}

function render(hits = records.map(record => ({ record }))) {
  imageUrls.forEach(url => URL.revokeObjectURL(url)); imageUrls = [];
  $('gallery').replaceChildren();
  if (!hits.length) {
    const message = document.createElement('p'); message.className = 'empty';
    message.textContent = 'Add a few photos to start your collection.'; $('gallery').append(message); return;
  }
  for (const { record, score } of hits) {
    const card = document.createElement('article'); card.className = 'card';
    const image = document.createElement('img'); image.alt = record.caption || record.name; image.loading = 'lazy';
    if (record.blob) { image.src = URL.createObjectURL(record.blob); imageUrls.push(image.src); }
    else image.src = new URL(record.asset, import.meta.url).href;
    const body = document.createElement('div'); body.className = 'card-body';
    const top = document.createElement('div'); top.className = 'card-top';
    const title = document.createElement('h3'); title.textContent = record.name; top.append(title);
    if (score !== undefined) { const value = document.createElement('span'); value.className = 'score'; value.textContent = `Similarity ${score.toFixed(3)}`; top.append(value); }
    const caption = document.createElement('p'); caption.textContent = record.caption || 'Added from this device';
    body.append(top, caption); card.append(image, body); $('gallery').append(card);
  }
}

function trace(steps) {
  $('trace').replaceChildren();
  for (const [step, elapsed] of steps) {
    const row = document.createElement('tr');
    for (const text of [step, `${elapsed.toFixed(1)} ms`]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    $('trace').append(row);
  }
}

export async function searchQuery(query) {
  await ready;
  if (busy) return;
  if (!records.length) { status('Add photos before searching.'); return; }
  if (!query.trim()) return;
  setBusy(true); status('Preparing text embeddings...');
  const started = performance.now();
  try {
    const vector = await embed('text', query.trim());
    const embedded = performance.now();
    const found = await orama.search(database, { mode: 'vector', vector: { property: 'embedding', value: vector }, similarity: -1, limit: 12 });
    const finished = performance.now();
    const byId = new Map(records.map(record => [record.id, record]));
    render(found.hits.map(hit => ({ record: byId.get(hit.id), score: hit.score })).filter(hit => hit.record));
    $('gallery-title').textContent = 'Search results';
    status(`${found.hits.length} results in ${Math.round(finished - started)} ms. Ranked by visual similarity.`);
    trace([['Text embedding (including model loading)', embedded - started], ['Vector retrieval', finished - embedded]]);
    return found;
  } catch (error) { status(friendlyError(error), true); throw error; }
  finally { setBusy(false); }
}

function friendlyError(error) {
  if (error.name === 'QuotaExceededError') return 'Browser storage is full. Reset the library or free some space before adding photos.';
  return error.message || 'Something went wrong. Please retry.';
}

async function thumbnail(file) {
  const image = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 960 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not decode image.')), 'image/jpeg', 0.86));
  } finally { image.close(); }
}

export async function addImages(files) {
  await ready;
  if (busy) return;
  if (files.length > 100) { status('Please add at most 100 photos at a time.', true); return; }
  setBusy(true); let added = 0, duplicates = 0;
  try {
    for (const [position, file] of [...files].entries()) {
      status(`Indexing photo ${position + 1} of ${files.length}...`);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: use a JPEG, PNG, or WebP image.`);
      if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: image exceeds 20 MB.`);
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (records.some(record => record.id === id)) { duplicates++; continue; }
      const blob = await thumbnail(file); const url = URL.createObjectURL(blob);
      let vector;
      try { vector = await embed('image', url); } finally { URL.revokeObjectURL(url); }
      const record = { id, name: file.name, caption: '', vector, model: MODEL_REVISION, blob };
      await write([record]); records.push(record); added++;
    }
    status(`Added ${added} photo${added === 1 ? '' : 's'}${duplicates ? `, skipped ${duplicates} duplicate${duplicates === 1 ? '' : 's'}` : ''}. Saved in this browser.`);
  } catch (error) { status(friendlyError(error), true); throw error; }
  finally { await rebuild(); render(); $('gallery-title').textContent = 'Your collection'; setBusy(false); $('files').value = ''; }
}

async function demoRecords() {
  const response = await fetch(new URL('./demo/collection.json', import.meta.url));
  if (!response.ok) throw new Error('Could not load the demo collection. Check your connection and refresh.');
  return response.json();
}

async function boot() {
  try {
    orama = await import('https://cdn.jsdelivr.net/npm/@orama/orama@3.1.18/+esm');
    records = await readAll();
    const compatible = records.filter(record => record.model === MODEL_REVISION && validVector(record.vector));
    if (compatible.length !== records.length) throw new Error('The saved library uses a different model. Reset to demo to continue.');
    if (!records.length) { records = await demoRecords(); await write(records); }
    await rebuild(); render(); status('Ready. Try a search or add your own photos.');
  } catch (error) { status(friendlyError(error), true); throw error; }
}

$('search-form').addEventListener('submit', event => { event.preventDefault(); searchQuery($('query').value).catch(() => {}); });
$('files').addEventListener('change', event => { addImages(event.target.files).catch(() => {}); });
document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => { $('query').value = button.dataset.query; searchQuery(button.dataset.query).catch(() => {}); }));
$('reset').addEventListener('click', async () => {
  await ready;
  if (busy || !confirm('Remove your imported photos from this browser and restore the demo collection?')) return;
  setBusy(true);
  try { records = await demoRecords(); await write(records, { replace: true }); await rebuild(); render(); $('gallery-title').textContent = 'Your collection'; status('Demo collection restored.'); }
  catch (error) { status(friendlyError(error), true); }
  finally { setBusy(false); }
});
export const ready = boot();
ready.catch(() => {});
