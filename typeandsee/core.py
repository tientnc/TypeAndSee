import hashlib
import io
import json
import os
import time
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
SUPPORTED_FORMATS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}


class ImageEncoder:
    def __init__(self):
        import open_clip
        import torch

        self.torch = torch
        self.model_name = os.getenv("CLIP_MODEL", "ViT-B-32")
        self.pretrained = os.getenv("CLIP_PRETRAINED", "laion2b_s34b_b79k")
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            self.model_name, pretrained=self.pretrained, device="cpu"
        )
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(self.model_name)

    def image(self, image):
        with self.torch.inference_mode():
            value = self.model.encode_image(self.preprocess(image).unsqueeze(0))
            value = value / value.norm(dim=-1, keepdim=True)
        return value[0].tolist()

    def text(self, query):
        with self.torch.inference_mode():
            value = self.model.encode_text(self.tokenizer([query]))
            value = value / value.norm(dim=-1, keepdim=True)
        return value[0].tolist()


def validated_image(raw):
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("Image exceeds the 20 MB upload limit")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("Unsupported or corrupt image") from exc
    if image.format not in SUPPORTED_FORMATS:
        raise ValueError("Only JPEG, PNG, and WebP images are supported")
    extension = SUPPORTED_FORMATS[image.format]
    image = ImageOps.exif_transpose(image).convert("RGB")
    return image, extension


class MediaStore:
    def __init__(self):
        self.bucket_name = os.getenv("GCS_BUCKET")
        self.local_path = Path(os.getenv("DATA_DIR", "data")) / "images"
        if self.bucket_name:
            from google.cloud import storage

            self.bucket = storage.Client().bucket(self.bucket_name)
        else:
            self.local_path.mkdir(parents=True, exist_ok=True)

    def put(self, image_id, raw, extension):
        key = f"{image_id}{extension}"
        if self.bucket_name:
            content_type = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}[extension]
            self.bucket.blob(key).upload_from_string(raw, content_type=content_type)
        else:
            path = self.local_path / key
            if not path.exists():
                path.write_bytes(raw)
        return key

    def get(self, key):
        if self.bucket_name:
            return self.bucket.blob(key).download_as_bytes()
        return (self.local_path / key).read_bytes()


class SearchService:
    def __init__(self, encoder=None, collection=None, media=None):
        if collection is None:
            if os.getenv("VECTOR_BACKEND") == "firestore":
                from .firestore_index import FirestoreIndex

                collection = FirestoreIndex()
            else:
                import chromadb

                host = os.getenv("CHROMA_HOST")
                if host:
                    client = chromadb.HttpClient(
                        host=host,
                        port=int(os.getenv("CHROMA_PORT", "8000")),
                        ssl=os.getenv("CHROMA_SSL", "false").lower() == "true",
                        headers={"Authorization": f"Bearer {os.environ['CHROMA_TOKEN']}"}
                        if os.getenv("CHROMA_TOKEN") else None,
                    )
                else:
                    path = Path(os.getenv("DATA_DIR", "data")) / "chroma"
                    path.mkdir(parents=True, exist_ok=True)
                    client = chromadb.PersistentClient(path=str(path))
                collection = client.get_or_create_collection(
                    name="images_v1", metadata={"hnsw:space": "cosine"}
                )
        self.collection = collection
        self.encoder = encoder or ImageEncoder()
        self.media = media or MediaStore()

    def add(self, raw, filename, caption="", tags=""):
        image, extension = validated_image(raw)
        image_id = hashlib.sha256(raw).hexdigest()
        existing = self.collection.get(ids=[image_id], include=[])
        if existing["ids"]:
            return {"id": image_id, "duplicate": True}
        embedding = self.encoder.image(image)
        key = self.media.put(image_id, raw, extension)
        metadata = {
            "filename": Path(filename).name[:255],
            "caption": caption[:2000],
            "tags": tags[:500],
            "media_key": key,
            "bytes": len(raw),
        }
        self.collection.upsert(ids=[image_id], embeddings=[embedding], metadatas=[metadata])
        return {"id": image_id, "duplicate": False}

    def search(self, query, limit=12, trace=None):
        start = time.perf_counter()
        embedding = self.encoder.text(query)
        if trace is not None:
            trace.append({"step": "embedding", "ms": round((time.perf_counter() - start) * 1000, 2)})
        start = time.perf_counter()
        count = self.collection.count() if hasattr(self.collection, "count") else None
        if count == 0:
            return []
        found = self.collection.query(
            query_embeddings=[embedding], n_results=min(limit, count) if count is not None else limit,
            include=["metadatas", "distances"],
        )
        if trace is not None:
            trace.append({"step": "retrieval", "ms": round((time.perf_counter() - start) * 1000, 2), "candidates": len(found["ids"][0])})
            trace.append({"step": "reranking", "ms": 0, "status": "disabled"})
        return [
            {"id": image_id, "score": round(1 - distance, 4),
             "filename": meta["filename"], "caption": meta.get("caption", ""),
             "tags": meta.get("tags", ""), "url": f"/api/images/{image_id}"}
            for image_id, meta, distance in zip(
                found["ids"][0], found["metadatas"][0], found["distances"][0]
            )
        ]

    def image_bytes(self, image_id):
        record = self.collection.get(ids=[image_id], include=["metadatas"])
        if not record["ids"]:
            raise KeyError(image_id)
        key = record["metadatas"][0]["media_key"]
        content_type = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(Path(key).suffix)
        return self.media.get(key), content_type


def explain(query, results, trace):
    """Generate text only from retrieved metadata, with explicit evidence IDs."""
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("Set GEMINI_API_KEY to enable grounded explanations")
    import urllib.request

    evidence = [{k: item[k] for k in ("id", "filename", "caption", "tags", "score")} for item in results]
    prompt = (
        "Explain why these retrieved images may match the user's query. Use only the "
        "provided captions, tags, filenames, and similarity scores. A similarity score "
        "alone does not prove a visual fact. Cite image IDs for every claim. If metadata "
        "cannot establish a detail, say that visual verification is needed. Keep it brief.\n"
        f"Query: {query}\nEvidence: {json.dumps(evidence)}"
    )
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    trace.append({"step": "generation", "ms": round((time.perf_counter() - start) * 1000, 2), "model": model, "usage": payload.get("usageMetadata", {})})
    return "\n".join(part.get("text", "") for part in payload["candidates"][0]["content"]["parts"])
