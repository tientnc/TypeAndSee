# Movie discovery

Type films you enjoyed to get recommendations for unseen films. The browser demo uses an attributed catalogue, real MiniLM sentence embeddings, an Orama vector index, and preference-aware reranking. It runs on GitHub Pages without a model API or paid backend.

## Your history

Add a film with the title picker to mark it liked. The history panel lets you change it to watched or disliked, or remove it. Every film marked liked, watched, or disliked is excluded from recommendation results. Favorites contribute to the taste profile; merely watched films do not imply a positive preference.

Import `watched.csv`, `ratings.csv`, or `watchlist.csv` from an unzipped Letterboxd export. CSV data is parsed locally. Title and year must identify a catalogue record unambiguously. Unmatched, ambiguous, and invalid rows are reported. Imported ratings from 3.5 to 5 are treated as likes, 0.5 to 2 as dislikes, and 2.5 to 3 as neutral watched films. Watchlist entries remain unwatched unless another imported record marks them watched.

History is saved in local browser storage. It is not sent to Letterboxd or a server, and it does not sync between browsers or devices. No Letterboxd API or scraping is used.

## Retrieval and ranking

The catalogue has 1,809 films. Its older records are selected from the CMU Movie Summary Corpus. Another 103 supplemental titles extend it through 2024. Original source links and data licenses appear in the app and in `catalogue/README.md`.

Each normalized 384-dimensional vector encodes the title, grouped genres, detailed genre tags, and plot or premise text. Up to eight diverse favorite-film anchors retrieve vector neighbors. Verified shared directors add candidates. A ranker combines plot similarity, shared genres and directors, an optional request embedding, and penalties for similarity to disliked films. Hard filters exclude seen titles and enforce genre, year, watchlist, and known-runtime constraints. A final diversity pass reduces repetitive suggestions.

An optional description can express a mood. Its first use downloads a quantized text model. Simple requests such as `under 120 minutes`, `before 2000`, and `no horror` also produce explicit filters, shown in the trace. Other language contributes to semantic similarity; it is not guaranteed to become a hard constraint. Use the controls for explicit constraints.

The main view is a perspective 3D PCA projection with drag rotation, zoom, optional auto rotation, and clickable dots. Add a title in the sidebar to highlight its dot in yellow. Open Suggestions to highlight retrieved films in mint. The sidebar also holds your saved list, CSV import, and filters. Projection changes distances. Recommendations use the original vectors.

## Explanations and tracing

Basic match reasons are computed from the actual favorite-film anchor, overlapping genres, and verified shared directors.

The trace records taste-anchor selection, vector retrieval, exclusion/filtering, reranking, and optional request-embedding timings. External model API cost per query is $0. Runtime and electricity are supplied by the visitor's device.

Generated RAG explanations and optional agent orchestration are planned for a later version. This release focuses on the working recommendation demo.

## Run and verify

```bash
python3 -m http.server 8000 --directory web
```

With Chrome installed, run the real-browser checks:

```bash
uv sync --extra test
uv run python scripts/movie_smoke.py
```

Use `--url https://tientnc.github.io/TypeAndSee/web/` to test the deployed site. The check exercises selection, exclusion, filters, CSV imports, watchlist semantics, persistence, the movie map, and encoder compatibility.

The evaluation suite in `catalogue/evaluation.json` has a small set of manually labeled semantic relationships. Its Recall@12 and NDCG@12 are compared with a box-office baseline. This is an incomplete content-relevance check, not a held-out user-preference benchmark or proof that a person will enjoy the recommendations.

The original image demo remains at `web/images/`, and the separate Python image API remains available. The deployed movie app does not require a cloud database, TMDB token, Letterboxd login, or paid billing account.

The recorded demo run in `catalogue/evaluation-results.json` measured mean Recall@12 of 0.493 and NDCG@12 of 0.483 across five labeled queries. The box-office baseline had Recall@12 of 0. Retrieval and reranking took roughly 5-10 ms per query on the test machine, excluding initial loading.

## Catalogue size

The 1,809-film catalogue is a demo selection. Its metadata and embeddings total about 6.3 MB, including 2.8 MB of raw vectors. The underlying source archive has 42,306 plot summaries and 81,741 metadata records. Many metadata records lack a plot. The 103 original supplemental premises extend coverage through 2024.

A 384-dimensional float32 embedding uses 1,536 bytes per film. Vectors for 100,000 films would require about 154 MB before metadata and index overhead. Larger catalogues are feasible. A broader source, incremental downloads, and an efficient retrieval index would help keep initial browser loading responsive.
