# TypeAndSee

Search images by a description such as **"a red bicycle beside a café"**. OpenCLIP maps images and text into one embedding space; Chroma stores and searches the image vectors. The FastAPI app includes a browser gallery, image import, an authenticated API option, trace records, optional grounded explanations, and a labeled evaluation command.

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

Set `APP_API_TOKEN` to require a bearer token on every `/api` endpoint. Enter that token in the UI; it is held only in the tab's memory. Keep the app on localhost if the token is unset.

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

The report includes per-query recall, mean Recall@K, p50/p95 latency, and the supplied infrastructure cost estimate per query. Cost is not inferred from local CPU time. For cloud use, calculate it from Cloud Run, Chroma hosting, GCS requests/egress, and optional Gemini usage over a measured interval, then pass the total divided by query count.

## GCP deployment blueprint

This repository is ready to deploy the API and UI to **private Cloud Run**, with media in **Cloud Storage** and vectors in a **persistent external Chroma server**. A Cloud Run filesystem is ephemeral, so never use the default local `data/` storage in deployment. Provision a TLS-enabled Chroma service with persistent storage before deploying; `CHROMA_HOST`, `CHROMA_PORT`, and `CHROMA_SSL` point to it. A managed Chroma endpoint or a Chroma server on a persistent GCE disk can fill this role. The server must be reachable from Cloud Run, and its credentials should live in Secret Manager. The vector index and bucket need backup and lifecycle policies appropriate to the images.

1. Create a GCS bucket and a runtime service account. Grant that account `roles/storage.objectUser` on the bucket.
2. Store the Chroma bearer token, and optional Gemini key, as Secret Manager secrets. Grant the runtime account secret access.
3. Build and deploy with the example below, substituting your project, region, bucket, Chroma endpoint, service account, and secret names. Set enough memory for CLIP and allow time for cold starts. The image build downloads Python packages; CLIP weights currently download on first model load, so the runtime needs outbound access to the model host.

```bash
gcloud run deploy typeandsee \
  --source . --region REGION --project PROJECT_ID \
  --service-account typeandsee@PROJECT_ID.iam.gserviceaccount.com \
  --no-allow-unauthenticated --memory 4Gi --cpu 2 --timeout 300 \
  --set-env-vars GCS_BUCKET=BUCKET,CHROMA_HOST=HOST,CHROMA_PORT=443,CHROMA_SSL=true \
  --set-secrets CHROMA_TOKEN=chroma-token:latest,GEMINI_API_KEY=gemini-api-key:latest
```

Use `gcloud run services add-iam-policy-binding` to grant intended users `roles/run.invoker`. For a local authenticated browser session:

```bash
gcloud run services proxy typeandsee --region REGION --project PROJECT_ID --port 8080
```

Open <http://localhost:8080>. Cloud Run's IAM layer authenticates both the page and API calls through the proxy. Cloud Run collects stdout logs in Cloud Logging; search errors and trace IDs appear there. Set Cloud Monitoring alerts for 5xx responses, latency, and instance memory. The `/healthz` endpoint checks that the web process is alive; it does not validate Chroma, GCS, or model readiness.

## Current scope

- CLIP image embeddings, persistent vector search, upload/import, UI: implemented.
- Retrieval-augmented explanations from captions and metadata: implemented when Gemini is configured.
- Per-request embedding, retrieval, disabled reranking, and generation timing: implemented. Reranking itself is not implemented.
- Labeled Recall@K and latency evaluation: implemented. Cloud cost/query needs measured billing input.
- GCP container and deployment configuration: supplied; no cloud resources are provisioned by this repository.
- Query-refinement agent, result-verification agent, and video search: future work. No ADK or LangGraph workflow is claimed.

The model can miss fine-grained attributes and spatial relations. A label set containing compound descriptions is essential before claiming good performance on queries such as "red bicycle beside a café."
