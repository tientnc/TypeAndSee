import json
import logging
import os
import secrets
import time
import uuid
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response

from .core import MAX_UPLOAD_BYTES, SearchService, explain


logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("typeandsee")
app = FastAPI(title="TypeAndSee", version="0.1.0")
STATIC = Path(__file__).parent / "static"


@lru_cache
def service():
    return SearchService()


def authorize(authorization: str | None = Header(default=None)):
    expected = os.getenv("APP_API_TOKEN")
    if expected and not secrets.compare_digest(authorization or "", f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="Valid bearer token required")


def log_trace(trace_id, query, trace, elapsed_ms, count, error=None):
    logger.info(json.dumps({
        "severity": "ERROR" if error else "INFO", "event": "search",
        "trace_id": trace_id, "query_hash": __import__("hashlib").sha256(query.encode()).hexdigest()[:16],
        "steps": trace, "elapsed_ms": round(elapsed_ms, 2), "results": count,
        "error": error,
    }))


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/api/images", dependencies=[Depends(authorize)])
async def upload(file: UploadFile = File(...), caption: str = Form(""), tags: str = Form("")):
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        return service().add(raw, file.filename or "image", caption, tags)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        logger.exception("image indexing failed")
        raise HTTPException(status_code=503, detail="Image indexing failed")


@app.get("/api/images/{image_id}", dependencies=[Depends(authorize)])
def get_image(image_id: str):
    if len(image_id) != 64 or any(ch not in "0123456789abcdef" for ch in image_id):
        raise HTTPException(status_code=404, detail="Image not found")
    try:
        raw, media_type = service().image_bytes(image_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Image not found") from exc
    return Response(content=raw, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/search", dependencies=[Depends(authorize)])
def search(q: str = Query(min_length=1, max_length=500), k: int = Query(12, ge=1, le=50), explain_matches: bool = False):
    trace_id = uuid.uuid4().hex
    trace = []
    start = time.perf_counter()
    try:
        results = service().search(q, k, trace)
        explanation = None
        if explain_matches and results:
            explanation = explain(q, results[:5], trace)
        elif explain_matches:
            trace.append({"step": "generation", "status": "skipped_no_results"})
        elapsed = (time.perf_counter() - start) * 1000
        log_trace(trace_id, q, trace, elapsed, len(results))
        return {"query": q, "results": results, "explanation": explanation,
                "trace_id": trace_id, "trace": trace, "elapsed_ms": round(elapsed, 2)}
    except RuntimeError as exc:
        log_trace(trace_id, q, trace, (time.perf_counter() - start) * 1000, 0, str(exc))
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception:
        logger.exception("search failed trace_id=%s", trace_id)
        log_trace(trace_id, q, trace, (time.perf_counter() - start) * 1000, 0, "internal_error")
        raise HTTPException(status_code=503, detail=f"Search failed; trace {trace_id}")
