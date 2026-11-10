const ORAMA = 'https://cdn.jsdelivr.net/npm/@orama/orama@3.1.18/+esm';

export function normalizedTitle(value) {
  const movedArticle = String(value).replace(/^(.*),\s*(The|An|A)$/i, '$2 $1');
  return movedArticle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cosine(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return Math.max(-1, Math.min(1, total));
}

export function parseCSV(input) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || !field) quoted = !quoted;
      else field += character;
    } else if (!quoted && character === ',') {
      row.push(field.trim());
      field = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('This CSV has an unclosed quoted field. Export it again and retry.');
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) throw new Error('The CSV is empty.');
  const headers = rows.shift().map(value => value.toLowerCase().replace(/[^a-z]/g, ''));
  const titleIndex = headers.findIndex(value => ['name', 'title', 'filmtitle'].includes(value));
  if (titleIndex < 0) throw new Error('Choose a Letterboxd CSV with a Name or Title column.');
  const yearIndex = headers.indexOf('year'),
    ratingIndex = headers.indexOf('rating');
  return rows.map((values, index) => ({
    title: values[titleIndex] || '',
    year: values[yearIndex] || '',
    rating: ratingIndex >= 0 ? values[ratingIndex] : '',
    line: index + 2
  }));
}

export function mergeCSV(movies, current, rows, filename) {
  const profile = structuredClone(current);
  const byTitle = new Map();
  for (const movie of movies) {
    const key = normalizedTitle(movie.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(movie);
  }
  const report = {
    matched: 0,
    unmatched: [],
    ambiguous: [],
    invalid: 0,
    watchlist: /watchlist/i.test(filename)
  };
  for (const row of rows) {
    let title = row.title;
    let year = /^\d{4}$/.test(row.year) ? Number(row.year) : null;
    const suffix = title.match(/\s+\((\d{4})\)$/);
    if (!year && suffix) {
      year = Number(suffix[1]);
      title = title.slice(0, suffix.index);
    }
    if (!title || (row.year && !year)) {
      report.invalid++;
      continue;
    }
    let matches = byTitle.get(normalizedTitle(title)) || [];
    if (year) matches = matches.filter(movie => movie.year === year);
    if (!matches.length) {
      report.unmatched.push(`${title}${year ? ` (${year})` : ''}`);
      continue;
    }
    if (matches.length !== 1) {
      report.ambiguous.push(title);
      continue;
    }
    const movie = matches[0],
      previous = profile[movie.id] || {};
    if (report.watchlist) profile[movie.id] = {
      ...previous,
      watchlist: true
    };
    else {
      const rawRating = row.rating === undefined || row.rating === '' ? null : Number(row.rating);
      if (rawRating !== null && (!Number.isFinite(rawRating) || rawRating < .5 || rawRating > 5 || rawRating * 2 % 1 !== 0)) {
        report.invalid++;
        continue;
      }
      const state = rawRating === null ? previous.status || 'seen' : rawRating >= 3.5 ? 'liked' : rawRating <= 2 ? 'disliked' : 'seen';
      profile[movie.id] = {
        ...previous,
        status: state,
        ...(rawRating === null ? {} : {
          rating: rawRating
        })
      };
    }
    report.matched++;
  }
  return {
    profile,
    report
  };
}

export function parseRequest(text, filters) {
  const result = {
    ...filters,
    excludeGenres: [...(filters.excludeGenres || [])]
  };
  const under = text.match(/(?:under|less than|shorter than)\s+(\d{2,3})\s*(?:minutes|mins|minute|min)\b/i);
  if (under) result.runtime = Math.min(result.runtime || Infinity, Number(under[1]) - 1);
  const before = text.match(/before\s+(19\d{2}|20\d{2})\b/i);
  if (before) result.maxYear = Math.min(result.maxYear || 2026, Number(before[1]) - 1);
  const after = text.match(/after\s+(19\d{2}|20\d{2})\b/i);
  if (after) result.minYear = Math.max(result.minYear || 1900, Number(after[1]) + 1);
  for (const [word, genre] of [
      ['horror', 'Horror'],
      ['animation', 'Animation'],
      ['romance', 'Romance'],
      ['comedy', 'Comedy']
    ]) {
    if (new RegExp(`(?:no|without|exclude|excluding)\\s+${word}\\b`, 'i').test(text)) result.excludeGenres.push(genre);
  }
  result.excludeGenres = [...new Set(result.excludeGenres)];
  return result;
}

export function allowed(movie, profile, filters) {
  if (profile[movie.id]?.status) return false;
  if (filters.watchlist && !profile[movie.id]?.watchlist) return false;
  if (filters.genre && !movie.genres.includes(filters.genre)) return false;
  if (filters.excludeGenres?.some(genre => movie.genres.includes(genre))) return false;
  if (filters.minYear && movie.year < filters.minYear) return false;
  if (filters.maxYear && movie.year > filters.maxYear) return false;
  if (filters.runtime && (!movie.runtime || movie.runtime > filters.runtime)) return false;
  return true;
}

export class MovieEngine {
  constructor(catalogue, vectors) {
    if (catalogue.dimensions !== 384 || vectors.length !== catalogue.movies.length * 384) throw new Error('The catalogue and embedding files do not match. Please refresh.');
    this.metadata = catalogue;
    this.movies = catalogue.movies.map((movie, index) => ({
      ...movie,
      vector: vectors.subarray(index * 384, (index + 1) * 384),
      key: normalizedTitle(movie.title)
    }));
    this.byId = new Map(this.movies.map(movie => [movie.id, movie]));
  }

  async initialize() {
    this.orama = await import(ORAMA);
    this.database = await this.orama.create({
      schema: {
        title: 'string',
        embedding: 'vector[384]'
      }
    });
    for (const movie of this.movies) await this.orama.insert(this.database, {
      id: movie.id,
      title: movie.title,
      embedding: Array.from(movie.vector)
    });
    return this;
  }

  findTitles(term, limit = 8) {
    const query = normalizedTitle(term);
    if (query.length < 2) return [];
    return this.movies.map(movie => ({
        movie,
        score: movie.key === query ? 100 : movie.key.startsWith(query) ? 70 : movie.key.includes(query) ? 40 : 0
      }))
      .filter(item => item.score).sort((a, b) => b.score - a.score || b.movie.revenue - a.movie.revenue || b.movie.year - a.movie.year)
      .slice(0, limit).map(item => item.movie);
  }

  anchors(profile, count = 8) {
    const choices = Object.entries(profile).filter(([id, entry]) => entry.status === 'liked' && this.byId.has(id))
      .map(([id, entry]) => ({
        movie: this.byId.get(id),
        weight: entry.rating ? .5 + (entry.rating - 3.5) / 1.5 : 1
      }))
      .sort((a, b) => b.weight - a.weight || b.movie.revenue - a.movie.revenue);
    if (!choices.length) return [];
    const selected = [choices.shift()];
    while (choices.length && selected.length < count) {
      const scores = choices.map(item => item.weight * (1 - Math.max(...selected.map(other => cosine(item.movie.vector, other.movie.vector)))));
      const index = scores.indexOf(Math.max(...scores));
      selected.push(choices.splice(index, 1)[0]);
    }
    return selected;
  }

  async recommend(profile, filters = {}, moodVector = null, limit = 12) {
    const started = performance.now(),
      anchors = this.anchors(profile);
    const available = this.movies.filter(movie => allowed(movie, profile, filters));
    const profilesAt = performance.now(),
      candidateIds = new Set();
    const queries = [...anchors.map(item => item.movie.vector), ...(moodVector ? [moodVector] : [])];
    if (!queries.length) {
      const highlights = ['Arrival', 'Spirited Away', 'Parasite', 'The Grand Budapest Hotel', 'The Matrix', 'Coco', 'Before Sunrise', 'Knives Out', 'The Truman Show', 'Perfect Days', 'Mad Max: Fury Road', 'Your Name'];
      const featured = highlights.flatMap(title => available.filter(movie => movie.title === title));
      const featuredIds = new Set(featured.map(movie => movie.id));
      const remaining = available.filter(movie => !featuredIds.has(movie.id)).sort((a, b) => b.revenue - a.revenue || a.title.localeCompare(b.title));
      const picks = [...featured, ...remaining].slice(0, limit);
      return {
        results: picks.map(movie => ({
          movie,
          reasons: ['Choose a film you enjoyed to personalize these suggestions.']
        })),
        anchors,
        trace: [{
          step: 'Catalogue browsing',
          ms: performance.now() - started,
          count: picks.length
        }],
        personalized: false,
        filters
      };
    }
    for (const vector of queries) {
      const found = await this.orama.search(this.database, {
        mode: 'vector',
        vector: {
          property: 'embedding',
          value: Array.from(vector)
        },
        similarity: -1,
        limit: 250
      });
      found.hits.forEach(hit => candidateIds.add(hit.id));
    }
    const favoriteDirectors = new Set(anchors.flatMap(item => item.movie.directors || []));
    for (const movie of available)
      if (movie.directors?.some(director => favoriteDirectors.has(director))) candidateIds.add(movie.id);
    // A restrictive history/filter combination must not silently discard valid lower-ranked candidates.
    if (available.filter(movie => candidateIds.has(movie.id)).length < Math.min(limit * 3, available.length)) available.forEach(movie => candidateIds.add(movie.id));
    const retrievedAt = performance.now();
    const dislikes = Object.entries(profile).filter(([id, entry]) => entry.status === 'disliked' && this.byId.has(id)).slice(0, 20).map(([id]) => this.byId.get(id));
    const scored = available.filter(movie => candidateIds.has(movie.id)).map(movie => {
      const similarities = anchors.map(anchor => ({
          ...anchor,
          similarity: cosine(movie.vector, anchor.movie.vector),
          directors: (movie.directors || []).filter(director => anchor.movie.directors?.includes(director))
        }))
        .sort((a, b) => (b.similarity + (b.directors.length ? .12 : 0)) - (a.similarity + (a.directors.length ? .12 : 0)));
      const best = similarities[0];
      const affinity = best ? .85 * best.similarity + .15 * similarities.slice(0, 3).reduce((sum, item) => sum + item.similarity, 0) / Math.min(3, similarities.length) : 0;
      const shared = best ? movie.genres.filter(genre => best.movie.genres.includes(genre)) : [];
      const overlap = best ? shared.length / new Set([...movie.genres, ...best.movie.genres]).size : 0;
      const negative = dislikes.length ? Math.max(0, ...dislikes.map(dislike => cosine(movie.vector, dislike.vector))) : 0;
      const mood = moodVector ? cosine(movie.vector, moodVector) : 0;
      const directorMatch = best?.directors.length ? 1 : 0;
      const score = moodVector ? (best ? .45 * affinity + .35 * mood + .1 * overlap + .1 * directorMatch : mood) - .15 * negative : .7 * affinity + .18 * overlap + .12 * directorMatch - .15 * negative;
      const reasons = [];
      if (best) reasons.push(`Similar plot embedding to ${best.movie.title}.`);
      if (shared.length) reasons.push(`Shares ${shared.slice(0, 3).join(', ')} with that favorite.`);
      if (best?.directors.length) reasons.unshift(`Also directed by ${best.directors.join(' and ')}.`);
      if (moodVector) reasons.push('Your current description also contributes to this ranking.');
      return {
        movie,
        score,
        anchor: best?.movie,
        similarity: best?.similarity,
        shared,
        sharedDirectors: best?.directors || [],
        reasons
      };
    }).sort((a, b) => b.score - a.score || a.movie.id.localeCompare(b.movie.id));
    const verifiedAt = performance.now(),
      selected = [];
    const remaining = scored.slice(0, 150);
    while (remaining.length && selected.length < limit) {
      let bestIndex = 0,
        bestScore = -Infinity;
      remaining.forEach((item, index) => {
        const redundancy = selected.length ? Math.max(...selected.map(other => cosine(item.movie.vector, other.movie.vector))) : 0;
        const adjusted = item.score - .12 * redundancy;
        if (adjusted > bestScore) {
          bestScore = adjusted;
          bestIndex = index;
        }
      });
      selected.push(remaining.splice(bestIndex, 1)[0]);
    }
    const finished = performance.now();
    return {
      results: selected,
      anchors,
      personalized: true,
      filters,
      trace: [{
        step: 'Taste anchor selection',
        ms: profilesAt - started,
        count: anchors.length,
        ids: anchors.map(item => item.movie.id)
      }, {
        step: 'Vector retrieval',
        ms: retrievedAt - profilesAt,
        count: candidateIds.size,
        ids: [...candidateIds],
        directorExpansion: [...favoriteDirectors]
      }, {
        step: 'Seen-film exclusion and hard filters',
        ms: verifiedAt - retrievedAt,
        count: scored.length
      }, {
        step: 'Diversity reranking',
        ms: finished - verifiedAt,
        count: selected.length
      }, ],
    };
  }
}