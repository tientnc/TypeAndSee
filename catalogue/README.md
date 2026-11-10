# Movie catalogue sources

The deployed catalogue contains a subset of the CMU Movie Summary Corpus plus original premise descriptions for 103 newer films in `modern.tsv`. CMU data was collected by David Bamman, Brendan O'Connor, and Noah A. Smith from Wikipedia and Freebase. Source: https://www.cs.cmu.edu/~ark/personas/

The corpus, selected excerpts, normalized metadata, original supplemental premises, embeddings, and map coordinates are distributed under Creative Commons Attribution-ShareAlike 3.0: https://creativecommons.org/licenses/by-sa/3.0/

Wikipedia contributors authored the source plot text. Each deployed record links to its film article, where contributor history is available. The build script shortens plot excerpts, groups genres, checks supplemental film pages, and extracts directors and numeric runtimes from Wikipedia. Unknown runtimes remain unknown. Plots may include spoilers, and source records may contain errors.

The text embeddings use `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, q8, mean pooling, unit normalization, and a 256-token maximum. Offline encoding uses one record at a time to match browser dynamic quantization. The image-search CLIP index uses a different embedding space.

Rebuild locally:

```bash
uv run hf download Xenova/all-MiniLM-L6-v2 onnx/model_quantized.onnx tokenizer.json tokenizer_config.json config.json --revision 751bff37182d3f1213fa05d7196b954e230abad9 --local-dir /tmp/typeandsee-movie-encoder
OPENBLAS_NUM_THREADS=2 uv run python scripts/build_movie_catalogue.py
```

The script downloads the CMU archive into a temporary cache and looks up supplemental Wikipedia source pages. It writes metadata and binary float32 embeddings into `web/movies/data/`. No API keys are used. The three-dimensional PCA movie space is illustrative. All ranking uses the full 384-dimensional vectors.

`evaluation.json` is a small, manually labeled content-relevance suite. Its labels are incomplete and do not establish that real users will enjoy the recommended films. The browser smoke test reports both its retrieval scores and a box-office baseline without tuning or hiding missing catalogue labels.
