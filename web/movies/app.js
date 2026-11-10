import {
  MovieProjector
} from './projector.js';
import {
  MovieEngine,
  parseCSV,
  mergeCSV,
  parseRequest
} from './engine.js';

export let space;

const $ = id => document.getElementById(id);
const STORAGE = 'typeandsee-movies-v1';
let engine, profile = {},
  lastResult, focusedOption = -1,
  titleOptions = [];
let worker, modelId = 0,
  runId = 0;
const pending = new Map(),
  moodCache = new Map();

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function shortMetadata(movie) {
  return `${movie.year}${movie.runtime ? ` / ${movie.runtime} min` : ''} / ${movie.genres.slice(0, 2).join(', ')}`;
}

function modelRequest(type, input, onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./model-worker.js', import.meta.url), {
      type: 'module'
    });
    worker.onmessage = ({
      data
    }) => {
      const request = pending.get(data.id);
      if (!request) return;
      if ('progress' in data) {
        request.onProgress?.(data.progress);
        return;
      }
      pending.delete(data.id);
      data.error ? request.reject(new Error(data.error)) : request.resolve(data);
    };
    worker.onerror = () => {
      for (const request of pending.values()) request.reject(new Error('The local model could not load. Check your connection or content blocker and retry.'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++modelId;
    pending.set(id, {
      resolve,
      reject,
      onProgress
    });
    worker.postMessage({
      id,
      type,
      input
    });
  });
}

export async function embedDescription(text, {
  metadata = false
} = {}) {
  const result = await modelRequest('embed', text);
  return metadata ? result : result.vector;
}

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(profile));
  } catch {
    status('Preferences work for this visit, but this browser could not save them.', true);
  }
}

function loadProfile() {
  try {
    const input = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const valid = {};
    for (const [id, item] of Object.entries(input)) {
      if (!engine.byId.has(id) || !item || typeof item !== 'object') continue;
      const entry = {};
      if (['liked', 'seen', 'disliked'].includes(item.status)) entry.status = item.status;
      if (item.watchlist === true) entry.watchlist = true;
      if (typeof item.rating === 'number' && item.rating >= .5 && item.rating <= 5) entry.rating = item.rating;
      if (entry.status || entry.watchlist) valid[id] = entry;
    }
    return valid;
  } catch {
    return {};
  }
}

export async function setFilm(id, mode) {
  await ready;
  if (!engine.byId.has(id)) return;
  if (mode === 'remove') {
    delete profile[id];
    if (space?.focused === id) space.focused = null;
  } else if (mode === 'watchlist') {
    profile[id] = {
      ...(profile[id] || {}),
      watchlist: true
    };
  } else {
    profile[id] = {
      ...(profile[id] || {}),
      status: mode
    };
    delete profile[id].rating;
  }
  save();
  renderProfile();
  return updateRecommendations();
}

function renderProfile() {
  const liked = Object.entries(profile).filter(([, entry]) => entry.status === 'liked');
  $('favorites').replaceChildren();
  if (!liked.length) $('favorites').append(element('span', 'Add 1-3 favorites to start. Watched films alone do not tell us what you liked.', 'muted'));
  for (const [id] of liked.slice(0, 14)) {
    const movie = engine.byId.get(id),
      chip = element('span', undefined, 'favorite');
    chip.append(element('span', movie.title));
    const remove = element('button', 'x');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${movie.title} from your history`);
    remove.addEventListener('click', () => setFilm(id, 'remove').catch(error => status(error.message, true)));
    chip.append(remove);
    $('favorites').append(chip);
  }
  if (liked.length > 14) $('favorites').append(element('span', `+ ${liked.length - 14} more favorites in your history`, 'muted'));
  const watched = Object.values(profile).filter(entry => entry.status).length;
  const watchlist = Object.values(profile).filter(entry => entry.watchlist && !entry.status).length;
  $('list-count').textContent = String(watched);
  $('history-summary').textContent = `Manage history: ${watched} watched, ${liked.length} liked, ${watchlist} on watchlist`;
  renderHistory();
}

function renderHistory() {
  const term = $('history-search').value.toLowerCase().trim();
  const entries = Object.entries(profile).filter(([id]) => engine.byId.get(id).title.toLowerCase().includes(term));
  $('history-list').replaceChildren();
  for (const [id, entry] of entries.slice(0, 100)) {
    const movie = engine.byId.get(id),
      row = element('div', undefined, 'history-row');
    row.append(element('span', `${movie.title} (${movie.year})${entry.rating ? ` / ${entry.rating}/5` : ''}`));
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Your preference for ${movie.title}`);
    for (const [value, label] of [
        ['liked', 'Liked'],
        ['seen', 'Watched'],
        ['disliked', 'Disliked'],
        ['watchlist', 'Watchlist only']
      ]) {
      const option = element('option', label);
      option.value = value;
      select.append(option);
    }
    select.value = entry.status || 'watchlist';
    select.addEventListener('change', async () => {
      if (select.value === 'watchlist') profile[id] = {
        watchlist: true
      };
      else {
        profile[id] = {
          ...entry,
          status: select.value
        };
        delete profile[id].rating;
      }
      save();
      renderProfile();
      await updateRecommendations();
    });
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => setFilm(id, 'remove'));
    row.append(select, remove);
    $('history-list').append(row);
  }
  if (entries.length > 100) $('history-list').append(element('p', `Showing 100 of ${entries.length} entries. Use the search field to narrow the list.`, 'muted'));
}

function closeOptions() {
  $('film-options').hidden = true;
  $('film-search').setAttribute('aria-expanded', 'false');
  $('film-search').removeAttribute('aria-activedescendant');
}

function renderOptions() {
  titleOptions = engine.findTitles($('film-search').value, 9);
  focusedOption = -1;
  $('film-options').replaceChildren();
  if (!$('film-search').value.trim()) {
    closeOptions();
    return;
  }
  $('film-options').hidden = false;
  $('film-search').setAttribute('aria-expanded', 'true');
  if (!titleOptions.length) $('film-options').append(element('p', 'No title match in this starter catalogue. Try another film or a shorter title.', 'muted'));
  for (const [index, movie] of titleOptions.entries()) {
    const button = element('button', undefined, 'option');
    button.type = 'button';
    button.id = `film-option-${index}`;
    button.setAttribute('role', 'option');
    button.append(element('strong', movie.title), element('span', `${movie.year}${profile[movie.id]?.status ? ' / in your history' : ''}`));
    button.addEventListener('click', () => chooseTitle(index));
    $('film-options').append(button);
  }
}

function chooseTitle(index) {
  const movie = titleOptions[index];
  if (!movie) return;
  $('film-search').value = '';
  closeOptions();
  $('film-search').focus();
  setFilm(movie.id, 'liked').then(() => space.focus(movie.id)).catch(() => {});
}

function filters() {
  const minYear = Number($('min-year').value) || null,
    maxYear = Number($('max-year').value) || null;
  if ((minYear && (!Number.isInteger(minYear) || minYear < 1900 || minYear > 2026)) || (maxYear && (!Number.isInteger(maxYear) || maxYear < 1900 || maxYear > 2026)) || (minYear && maxYear && minYear > maxYear)) throw new Error('Choose a valid year range between 1900 and 2026.');
  return {
    genre: $('genre').value,
    runtime: Number($('runtime').value) || null,
    minYear,
    maxYear,
    watchlist: $('watchlist-only').checked
  };
}

export async function updateRecommendations() {
  await ready;
  const sequence = ++runId,
    started = performance.now();
  $('recommend-button').disabled = true;
  let embeddingTrace = [];
  try {
    const request = $('mood').value.trim(),
      appliedFilters = parseRequest(request, filters());
    let vector;
    if (request) {
      $('progress').hidden = false;
      status('Preparing your description...');
      if (!moodCache.has(request)) moodCache.set(request, modelRequest('embed', request, percent => {
        if (sequence === runId) {
          $('progress').max = 100;
          $('progress').value = percent;
          status(`Downloading the text model: ${percent}%. Future searches can reuse its browser cache.`);
        }
      }).catch(error => {
        moodCache.delete(request);
        throw error;
      }));
      const output = await moodCache.get(request);
      vector = output.vector;
      embeddingTrace = [{
        step: 'Request embedding (including initial model loading)',
        ms: performance.now() - started,
        count: 1
      }];
    }
    const result = await engine.recommend(profile, appliedFilters, vector);
    if (sequence !== runId) return result;
    result.trace.unshift(...embeddingTrace);
    result.request = request;
    result.elapsed = performance.now() - started;
    lastResult = result;
    renderResults();
    renderTrace();
    $('result-eyebrow').textContent = result.personalized ? 'A FEW PLACES TO GO NEXT' : 'THE STARTING POINT';
    $('result-heading').textContent = result.personalized ? 'Your next watch' : 'Explore the catalogue';
    status(result.results.length ? `${result.results.length} suggestions / ${Math.round(result.elapsed)} ms${result.anchors.length ? ` / ${result.anchors.length} taste anchor${result.anchors.length === 1 ? '' : 's'}` : ''}.` : 'No unseen films match these filters. Try a wider year range, genre, or runtime.');
    return result;
  } catch (error) {
    if (sequence === runId) status(error.message, true);
    throw error;
  } finally {
    if (sequence === runId) {
      $('recommend-button').disabled = false;
      $('progress').hidden = true;
      $('progress').removeAttribute('value');
    }
  }
}

function renderResults() {
  $('cards').replaceChildren();
  if (!lastResult.results.length) {
    const empty = element('div', undefined, 'empty');
    empty.append(element('strong', 'A little more room to explore?'), element('p', 'No unseen films match the current filters. Unknown runtimes are excluded when a length limit is applied.'));
    $('cards').append(empty);
  }
  for (const item of lastResult.results) {
    const movie = item.movie,
      card = element('article', undefined, 'card');
    card.dataset.movieId = movie.id;
    const poster = element('button', undefined, 'poster');
    poster.type = 'button';
    poster.setAttribute('aria-label', `Details and sources for ${movie.title}`);
    poster.append(element('span', String(movie.year), 'poster-year'), element('h3', movie.title));
    poster.addEventListener('click', () => space.focus(movie.id));
    const body = element('div', undefined, 'card-body');
    body.append(element('div', shortMetadata(movie), 'film-meta'));
    body.append(element('p', item.reasons.slice(0, 2).join(' '), 'match-reason'));
    const actions = element('div', undefined, 'card-actions');
    const seen = element('button', 'Watched it');
    seen.type = 'button';
    seen.addEventListener('click', () => setFilm(movie.id, 'seen'));
    const why = element('button', 'Why this film?');
    why.type = 'button';
    why.addEventListener('click', () => openFilm(movie.id));
    actions.append(seen, why);
    body.append(actions);
    card.append(poster, body);
    $('cards').append(card);
  }
  renderMap();
}

function renderMap() {
  space.update(profile, lastResult.results);
}

function showPanel(name) {
  for (const panel of ['add', 'list', 'suggestions']) {
    $(`panel-${panel}`).hidden = panel !== name;
    $(`tab-${panel}`).setAttribute('aria-selected', String(panel === name));
  }
  space?.setSuggestions(name === 'suggestions');
}

function renderTrace() {
  $('trace').replaceChildren();
  for (const step of lastResult.trace) {
    const row = element('tr');
    row.append(element('td', step.step), element('td', `${step.ms.toFixed(1)} ms`), element('td', step.count === undefined ? '-' : String(step.count)));
    $('trace').append(row);
  }
  $('trace-summary').textContent = lastResult.anchors.length ? `Taste anchors: ${lastResult.anchors.map(item => item.movie.title).join(', ')}. The ranker keeps multiple interests instead of averaging all your favorites into one point.` : 'Choose favorites or describe a film to start personalized retrieval.';
  const f = lastResult.filters;
  $('applied-filters').textContent = `Applied filters: ${[f.genre, f.runtime ? `runtime at most ${f.runtime} minutes (unknown runtimes excluded)` : '', f.minYear ? `from ${f.minYear}` : '', f.maxYear ? `through ${f.maxYear}` : '', f.excludeGenres?.length ? `exclude ${f.excludeGenres.join(', ')}` : '', f.watchlist ? 'your watchlist only' : ''].filter(Boolean).join('; ') || 'none'}. All films marked liked, watched, or disliked are excluded.`;
}

function sourceLink(movie, text = 'View source record') {
  const link = element('a', text, 'source-link');
  link.href = movie.sourceUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  return link;
}

function openFilm(id) {
  const movie = engine.byId.get(id);
  if (!movie) return;
  const result = lastResult.results.find(item => item.movie.id === id);
  $('film-detail').replaceChildren(element('p', String(movie.year), 'eyebrow'), element('h2', movie.title), element('p', shortMetadata(movie)));
  if (result) $('film-detail').append(element('p', result.reasons.join(' ')));
  const synopsis = element('details');
  synopsis.append(element('summary', 'Plot excerpt (may contain spoilers)'), element('p', movie.synopsis));
  $('film-detail').append(synopsis, sourceLink(movie));
  $('film-actions').replaceChildren();
  for (const [mode, label] of [
      ['liked', 'I liked it'],
      ['seen', 'Mark watched'],
      ['disliked', 'Not for me'],
      ['watchlist', 'Add to watchlist']
    ]) {
    const button = element('button', label, profile[id]?.status === mode || (mode === 'watchlist' && profile[id]?.watchlist) ? 'active' : '');
    button.type = 'button';
    button.addEventListener('click', () => {
      $('film-dialog').close();
      setFilm(id, mode);
    });
    $('film-actions').append(button);
  }
  $('evidence').replaceChildren();
  if (result?.anchor) {
    const evidence = element('details');
    evidence.append(element('summary', 'Retrieved matching evidence (may contain spoilers)'));
    for (const [label, item] of [
        ['Candidate', movie],
        ['Your favorite', result.anchor]
      ]) {
      evidence.append(element('p', `${label}: ${item.title} (${item.year}) / ${item.genres.join(', ')}`), element('blockquote', item.synopsis.slice(0, 420)), sourceLink(item));
    }
    $('evidence').append(evidence);
  }
  if (!$('film-dialog').open) $('film-dialog').showModal();
}

export async function importFiles(files) {
  await ready;
  let nextProfile = structuredClone(profile),
    matched = 0,
    invalid = 0;
  const unmatched = [],
    ambiguous = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Unzip your Letterboxd export and choose its CSV files.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose CSV files smaller than 5 MB.');
    const rows = parseCSV(await file.text());
    if (rows.length > 50000) throw new Error('Import at most 50,000 rows at a time.');
    const merged = mergeCSV(engine.movies, nextProfile, rows, file.name);
    nextProfile = merged.profile;
    matched += merged.report.matched;
    invalid += merged.report.invalid;
    unmatched.push(...merged.report.unmatched);
    ambiguous.push(...merged.report.ambiguous);
  }
  profile = nextProfile;
  save();
  renderProfile();
  $('import-report').hidden = false;
  $('import-summary').textContent = `Import report: ${matched} matched rows, ${unmatched.length} unmatched, ${ambiguous.length} ambiguous, ${invalid} invalid`;
  $('import-detail').textContent = `Your history is stored locally. Only catalogue matches can be used. Unrated watched films are exclusions, while ratings of 3.5-5 become likes and 0.5-2 become dislikes. Watchlist entries remain eligible recommendations.`;
  $('unmatched').replaceChildren(...[...unmatched.map(title => `Unmatched: ${title}`), ...ambiguous.map(title => `Ambiguous: ${title}`)].slice(0, 40).map(title => element('li', title)));
  await updateRecommendations();
  return {
    matched,
    unmatched,
    ambiguous,
    invalid
  };
}

export function snapshot() {
  return {
    profile: structuredClone(profile),
    results: lastResult?.results.map(item => ({
      id: item.movie.id,
      title: item.movie.title,
      year: item.movie.year,
      runtime: item.movie.runtime,
      genres: item.movie.genres,
      anchor: item.anchor?.title,
      score: item.score
    })),
    filters: lastResult?.filters,
    trace: lastResult?.trace
  };
}

async function boot() {
  try {
    const [metadataResponse, vectorResponse] = await Promise.all([fetch(new URL('./data/catalogue.json?projection=3d', import.meta.url)), fetch(new URL('./data/embeddings.f32', import.meta.url))]);
    if (!metadataResponse.ok || !vectorResponse.ok) throw new Error('The film catalogue could not load. Please check your connection and refresh.');
    const [metadata, vectors] = await Promise.all([metadataResponse.json(), vectorResponse.arrayBuffer()]);
    engine = await new MovieEngine(metadata, new Float32Array(vectors)).initialize();
    profile = loadProfile();
    space = new MovieProjector($('movie-map'), engine.movies, openFilm);
    for (const genre of [...new Set(engine.movies.flatMap(movie => movie.genres))].sort()) {
      const option = element('option', genre);
      option.value = genre;
      $('genre').append(option);
    }
    $('catalogue-count').textContent = `${engine.movies.length.toLocaleString()} films in this catalogue`;
    $('coverage').textContent = `A starter catalogue of ${engine.movies.length.toLocaleString()} films, including ${metadata.modernCount} newer titles through 2024. Plot excerpts can contain spoilers; source links and dataset licenses are provided.`;
    renderProfile();
    if ($('film-search').value.trim()) renderOptions();
    // Avoid awaiting updateRecommendations here: it waits for the exported ready promise.
    queueMicrotask(() => updateRecommendations().catch(() => {}));
    return engine;
  } catch (error) {
    status(error.message, true);
    throw error;
  }
}

$('film-search').addEventListener('input', () => {
  if (engine) renderOptions();
});
$('film-search').addEventListener('keydown', event => {
  if (event.key === 'Escape') closeOptions();
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && titleOptions.length) {
    event.preventDefault();
    focusedOption = focusedOption < 0 ? (event.key === 'ArrowDown' ? 0 : titleOptions.length - 1) : (focusedOption + (event.key === 'ArrowDown' ? 1 : -1) + titleOptions.length) % titleOptions.length;
    document.querySelectorAll('.option').forEach((option, index) => option.classList.toggle('focused', index === focusedOption));
    $('film-search').setAttribute('aria-activedescendant', `film-option-${focusedOption}`);
  }
  if (event.key === 'Enter' && titleOptions.length && !$('film-options').hidden) {
    event.preventDefault();
    chooseTitle(Math.max(0, focusedOption));
  }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.picker')) closeOptions();
});
$('history-search').addEventListener('input', () => engine && renderHistory());
$('recommend-form').addEventListener('submit', event => {
  event.preventDefault();
  updateRecommendations().catch(() => {});
});
for (const id of ['genre', 'runtime', 'min-year', 'max-year', 'watchlist-only']) $(id).addEventListener('change', () => updateRecommendations().catch(() => {}));
for (const panel of ['add', 'list', 'suggestions']) {
  $(`tab-${panel}`).addEventListener('click', () => showPanel(panel));
}
$('show-suggestions').addEventListener('click', () => showPanel('suggestions'));
$('reset-space').addEventListener('click', () => space?.reset());
$('zoom-in').addEventListener('click', () => {
  if (space) space.distance = Math.max(1.6, space.distance - .3);
});
$('zoom-out').addEventListener('click', () => {
  if (space) space.distance = Math.min(7, space.distance + .3);
});
$('rotate-space').addEventListener('click', () => {
  if (!space) return;
  space.autoRotate = !space.autoRotate;
  $('rotate-space').setAttribute('aria-pressed', String(space.autoRotate));
});
$('csv-files').addEventListener('change', async event => {
  try {
    await importFiles([...event.target.files]);
  } catch (error) {
    status(error.message, true);
  } finally {
    event.target.value = '';
  }
});
$('clear-profile').addEventListener('click', async () => {
  if (!confirm('Clear the saved movie history in this browser?')) return;
  profile = {};
  space.focused = null;
  save();
  renderProfile();
  $('import-report').hidden = true;
  await updateRecommendations();
});
$('close-dialog').addEventListener('click', () => $('film-dialog').close());
const presets = {
  scifi: ['Arrival', 'Interstellar', 'Blade Runner 2049'],
  animation: ['Spirited Away', 'Coco', 'Spider-Man: Into the Spider-Verse'],
  drama: ['Past Lives', 'Aftersun', 'Lost in Translation']
};
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', async () => {
  await ready;
  for (const title of presets[button.dataset.preset]) {
    const movie = engine.findTitles(title).find(item => item.title === title);
    if (movie && !profile[movie.id]?.status) profile[movie.id] = {
      ...(profile[movie.id] || {}),
      status: 'liked'
    };
  }
  save();
  renderProfile();
  await updateRecommendations();
}));
export const ready = boot();
ready.catch(() => {});