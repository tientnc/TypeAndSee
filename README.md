# TypeAndSee

Search photos with a description, such as **"a red bicycle beside a café"**.

[Open the browser demo](https://tientnc.github.io/TypeAndSee/). Search runs on your device, with no account or API key.

![TypeAndSee search interface](docs/ui.png)

*The browser interface for image upload, natural language search, and optional explanations.*

![Image search flow](docs/flow.svg)

*CLIP creates image and text embeddings. Chroma searches locally; Firestore supports GCP deployment. Captions and metadata can support an optional generated explanation.*

```bash
uv sync --extra test
uv run uvicorn typeandsee.api:app --reload
```

Open [localhost:8000](http://localhost:8000). See the [Python app guide](docs/guide.md) for imports, evaluation, and tracing, or the [browser demo guide](docs/browser-demo.md) for the free static deployment.
