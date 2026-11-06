# TypeAndSee

Search images by a description such as **"a red bicycle beside a café"**. OpenCLIP maps images and text into one embedding space. Chroma stores vectors locally, and Firestore can store them on GCP. The FastAPI app includes a browser gallery, image import, trace records, optional grounded explanations, and a labeled evaluation command.

## Run locally

Requirements: Python 3.11+, `uv`, and enough disk space for a CPU PyTorch install and the CLIP weights. The first search or upload downloads the selected OpenCLIP weights.

```bash
uv sync --extra test
uv run uvicorn typeandsee.api:app --reload
```

Open <http://127.0.0.1:8000>, upload JPEG, PNG, or WebP images, then search. The first request loads the model and can take longer. Images and the Chroma index persist under `data/`.

For a folder of images:

```bash
uv run python -m typeandsee.cli /path/to/photos --recursive
```

Set `APP_API_TOKEN` to require a bearer token for uploads. Search and image viewing remain public. Enter the token in the upload panel; it is held only in the tab's memory. Set `APP_REQUIRE_UPLOAD_AUTH=true` on a public deployment to prevent uploads if no token is configured.

### API

```bash
curl -F 'file=@photo.jpg' -F 'caption=red bicycle beside a café' http://localhost:8000/api/images
curl 'http://localhost:8000/api/search?q=a%20red%20bicycle%20beside%20a%20caf%C3%A9&k=10'
```

Upload responses include the image's SHA-256 ID. The search response includes scores, captions, trace ID, step timings, and total latency. Traces are also written as structured JSON to stdout; raw queries and image bytes are omitted from logs.

### Grounded explanations

Set `GEMINI_API_KEY` on the server and select **Explain matches**. The API retrieves images and their captions, tags, filenames, and scores, then asks Gemini to explain the match using only that evidence and image IDs. This is a retrieval-augmented generation path. A bare similarity score does not prove that a particular object is in an image; explanations should say when the stored metadata is insufficient. The implementation does not yet send image pixels for visual verification.

### Evaluation

Create a JSON file like `examples/labels.example.json` with real uploaded image IDs. Each query needs all images you judge relevant, including misses if you want a meaningful Recall@K.

```bash
uv run python -m typeandsee.evaluate labels.json --k 10 --cost-per-query 0.0001
```

The report includes per-query recall, mean Recall@K, p50/p95 latency, and the supplied infrastructure cost estimate per query. Cost is not inferred from local CPU time. For cloud use, calculate it from Cloud Run, Firestore, GCS requests/egress, and optional Gemini usage over a measured interval, then pass the total divided by query count.

## GCP deployment

For a public demo with free-tier limits, use Cloud Run for the app, Cloud Storage for public demo images, and Firestore for the vector index. See the [GCP free-tier guide](gcp-free-tier.md) for project setup and deployment commands. Cloud Run collects stdout logs in Cloud Logging. The `/healthz` endpoint checks that the web process is alive; it does not validate Firestore, GCS, or model readiness.

## Current scope

- CLIP image embeddings, persistent vector search, upload/import, UI: implemented.
- Retrieval-augmented explanations from captions and metadata: implemented when Gemini is configured.
- Per-request embedding, retrieval, disabled reranking, and generation timing: implemented. Reranking itself is not implemented.
- Labeled Recall@K and latency evaluation: implemented. Cloud cost/query needs measured billing input.
- GCP container and Firestore vector backend: supplied; no cloud resources are provisioned by this repository.
- Query-refinement agent, result-verification agent, and video search: future work. No ADK or LangGraph workflow is claimed.

The model can miss fine-grained attributes and spatial relations. A label set containing compound descriptions is essential before claiming good performance on queries such as "red bicycle beside a café."
