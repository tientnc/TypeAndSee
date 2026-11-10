"""Build an attributed movie catalogue and normalized MiniLM embeddings offline."""

import argparse
import csv
import hashlib
import json
import math
import re
import tarfile
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
MODEL = "Xenova/all-MiniLM-L6-v2"
REVISION = "751bff37182d3f1213fa05d7196b954e230abad9"
GENRES = {
    "Science Fiction": r"science fiction|sci-fi|sci fi",
    "Animation": r"animat|anime", "Adventure": r"adventure", "Action": r"action",
    "Comedy": r"comedy|comic|comedic", "Drama": r"drama", "Thriller": r"thriller|suspense",
    "Horror": r"horror", "Fantasy": r"fantasy|fairy tale", "Romance": r"romance|romantic",
    "Mystery": r"mystery|detective", "Crime": r"crime|gangster|heist",
    "Family": r"family|children", "War": r"war film|anti-war|military",
    "History": r"historical|history", "Music": r"musical|music film|concert", "Western": r"western",
    "Documentary": r"documentary",
}


def key(title):
    match = re.search(r",\s*(The|A|An)$", title, flags=re.I)
    if match:
        title = match[1] + " " + title[:match.start()]
    title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", title)


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "TypeAndSee/0.4 (https://github.com/tientnc/TypeAndSee)"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def load_cmu(folder):
    names = {"movie.metadata.tsv", "plot_summaries.txt", "README.txt"}
    if not all((folder / name).exists() for name in names):
        archive = folder / "MovieSummaries.tar.gz"
        if not archive.exists():
            archive.write_bytes(get("https://www.cs.cmu.edu/~ark/personas/data/MovieSummaries.tar.gz"))
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                if Path(member.name).name in names:
                    (folder / Path(member.name).name).write_bytes(source.extractfile(member).read())
    plots = {}
    with (folder / "plot_summaries.txt").open() as source:
        for line in source:
            movie_id, text = line.rstrip().split("\t", 1)
            plots[movie_id] = re.sub(r"\s+", " ", text).strip()
    movies = []
    with (folder / "movie.metadata.tsv").open() as source:
        for row in csv.reader(source, delimiter="\t"):
            if len(row) != 9 or row[0] not in plots or not re.match(r"^\d{4}", row[3]):
                continue
            year = int(row[3][:4])
            if not 1900 <= year <= 2026:
                continue
            runtime = float(row[5]) if row[5] else None
            if runtime is not None and (runtime < 45 or runtime > 400):
                continue
            text = plots[row[0]]
            if len(text) < 140:
                continue
            detailed_genres = list(json.loads(row[8]).values())
            raw_genres = " ".join(detailed_genres).lower()
            genres = [name for name, pattern in GENRES.items() if re.search(pattern, raw_genres)]
            if not genres or "Documentary" in genres:
                continue
            excerpt = text[:1800]
            if len(text) > 1800 and ". " in excerpt:
                excerpt = excerpt.rsplit(". ", 1)[0] + "."
            movies.append({
                "id": "wiki-" + row[0], "title": row[2], "year": year, "genres": genres,
                "runtime": math.ceil(runtime) if runtime else None,
                "synopsis": excerpt, "sourceUrl": "https://en.wikipedia.org/?curid=" + row[0],
                "source": "cmu-wikipedia", "revenue": int(float(row[4])) if row[4] else 0,
                "keywords": detailed_genres[:18],
            })
    ordered = sorted(movies, key=lambda movie: movie["revenue"], reverse=True)
    selected = {movie["id"]: movie for movie in ordered[:1500]}
    # Keep less commercially prominent genres represented without inventing a quality score.
    for genre in GENRES:
        options = [movie for movie in movies if genre in movie["genres"] and not movie["revenue"]]
        options.sort(key=lambda movie: hashlib.sha256(movie["id"].encode()).hexdigest())
        for movie in options[:15]:
            selected[movie["id"]] = movie
    essentials = {
        "The Matrix", "Inception", "Memento", "Moon", "Primer", "2001: A Space Odyssey", "Solaris",
        "Spirited Away", "My Neighbor Totoro", "Princess Mononoke", "Kiki's Delivery Service",
        "Grave of the Fireflies", "Howl's Moving Castle", "Paprika", "Perfect Blue", "Tokyo Godfathers",
        "Ghost in the Shell", "Akira", "Fantastic Mr. Fox", "Coraline", "Amelie", "Amélie",
        "Eternal Sunshine of the Spotless Mind", "Lost in Translation", "Before Sunrise", "Before Sunset",
        "Chungking Express", "In the Mood for Love", "Yi Yi", "Paris, Texas", "12 Angry Men", "Stalker",
        "Persona", "Seven Samurai", "Tokyo Story", "Bicycle Thieves", "City of God", "Oldboy",
        "Memories of Murder", "A Separation", "Incendies", "WALL-E", "The Iron Giant", "The Truman Show",
        "Blade Runner", "The Day the Earth Stood Still", "The Man from Earth", "The Machinist",
        "The Darjeeling Limited", "The Life Aquatic with Steve Zissou",
    }
    wanted = {key(title) for title in essentials}
    for movie in movies:
        if key(movie["title"]) in wanted or (movie["title"] == "Dune" and movie["year"] == 1984):
            selected[movie["id"]] = movie
    return list(selected.values())


def modern_metadata(folder):
    cache = folder / "modern-wikipedia.json"
    if cache.exists():
        return json.loads(cache.read_text())
    rows = list(csv.DictReader((ROOT / "catalogue/modern.tsv").open(), delimiter="\t"))
    result = {}
    for start in range(0, len(rows), 15):
        batch = rows[start:start + 15]
        params = {"action": "query", "format": "json", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": 1, "titles": "|".join(row["wiki"] for row in batch)}
        info = json.loads(get("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params)))
        pages = {page["title"]: page for page in info.get("query", {}).get("pages", {}).values()}
        redirects = {entry["from"]: entry["to"] for entry in info.get("query", {}).get("redirects", [])}
        for row in batch:
            title = row["wiki"]
            for _ in range(5):
                title = redirects.get(title, title)
            page = pages.get(title)
            if not page or "missing" in page:
                raise ValueError("Wikipedia source not found: " + row["wiki"])
            content = page["revisions"][0]["slots"]["main"]["*"]
            runtime = re.search(r"\|\s*runtime\s*=\s*(\d{2,3})\b", content)
            result[row["wiki"]] = {"wikiId": page["pageid"], "runtime": int(runtime[1]) if runtime else None}
        print("Verified modern film metadata", min(start + 15, len(rows)), "/", len(rows), flush=True)
    cache.write_text(json.dumps(result))
    return result


def load_modern(folder):
    sources = modern_metadata(folder)
    movies = []
    with (ROOT / "catalogue/modern.tsv").open() as source:
        for row in csv.DictReader(source, delimiter="\t"):
            metadata = sources[row["wiki"]]
            movies.append({
                "id": "wiki-" + str(metadata["wikiId"]), "title": row["title"], "year": int(row["year"]),
                "genres": row["genres"].split("|"), "runtime": metadata["runtime"],
                "synopsis": row["synopsis"], "sourceUrl": "https://en.wikipedia.org/?curid=" + str(metadata["wikiId"]),
                "source": "original-premise", "revenue": 0,
                "keywords": [],
            })
    return movies


def add_directors(movies, folder):
    cache_path = folder / "directors.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    missing = [movie for movie in movies if movie["id"] not in cache]
    for start in range(0, len(missing), 20):
        batch = missing[start:start + 20]
        params = {"action": "query", "format": "json", "prop": "revisions", "rvprop": "content", "rvslots": "main", "rvsection": 0, "pageids": "|".join(movie["id"][5:] for movie in batch)}
        pages = json.loads(get("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params))).get("query", {}).get("pages", {})
        for movie in batch:
            page = pages.get(movie["id"][5:], {})
            content = (page.get("revisions") or [{}])[0].get("slots", {}).get("main", {}).get("*", "")
            match = re.search(r"^\s*\|\s*director\s*=\s*(.*?)(?=^\s*\||^\s*\}\})", content, re.M | re.S)
            names = []
            if match:
                field = re.sub(r"<!--.*?-->|<ref\b[^>]*>.*?</ref>|<ref\b[^>]*/>", "", match[1], flags=re.S | re.I)
                names = re.findall(r"\[\[([^\]|#]+)(?:[^\]]*)\]\]", field)
                if not names:
                    field = re.sub(r"\{\{(?:plainlist|unbulleted list|ubl|hlist|nowrap)\|?|\}\}", "", field, flags=re.I)
                    field = re.sub(r"<[^>]+>", "\n", field)
                    names = [name.strip(" *|\n\r\t") for name in re.split(r"\n|\|", field)]
                names = [re.sub(r"\s*\([^)]*\)$", "", name).strip() for name in names if 2 < len(name.strip()) < 90 and not any(char in name for char in "{}<>:")]
            cache[movie["id"]] = list(dict.fromkeys(names))[:5]
        cache_path.write_text(json.dumps(cache))
        print("Verified director metadata", min(start + 20, len(missing)), "/", len(missing), flush=True)
    for movie in movies:
        movie["directors"] = cache.get(movie["id"], [])


def encode(movies, model_dir):
    tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_dir / "onnx/model_quantized.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    names = {entry.name for entry in session.get_inputs()}
    vectors = []
    # Dynamic quantization depends on the batch's activation ranges. Match the
    # browser's one-query-at-a-time path rather than mixing films in a batch.
    for start in range(0, len(movies)):
        batch = movies[start:start + 1]
        texts = [f"{movie['title']}. Genres: {', '.join(movie['genres'])}. Tags: {', '.join(movie.get('keywords', []))}. {movie['synopsis']}" for movie in batch]
        inputs = tokenizer.encode_batch(texts)
        mask = np.asarray([item.attention_mask for item in inputs], dtype=np.int64)
        values = {"input_ids": np.asarray([item.ids for item in inputs], dtype=np.int64), "attention_mask": mask}
        if "token_type_ids" in names:
            values["token_type_ids"] = np.asarray([item.type_ids for item in inputs], dtype=np.int64)
        hidden = session.run(None, values)[0]
        pooled = (hidden * mask[..., None]).sum(axis=1) / mask.sum(axis=1, keepdims=True)
        pooled /= np.linalg.norm(pooled, axis=1, keepdims=True)
        vectors.extend(pooled.astype(np.float32))
        if start % 160 == 0:
            print("Embedded", start + len(batch), "/", len(movies), flush=True)
    return np.asarray(vectors, dtype=np.float32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path("/tmp/typeandsee-movie-data"))
    parser.add_argument("--model-dir", type=Path, default=Path("/tmp/typeandsee-movie-encoder"))
    args = parser.parse_args()
    args.source_dir.mkdir(parents=True, exist_ok=True)
    merged = {movie["id"]: movie for movie in load_cmu(args.source_dir)}
    merged.update({movie["id"]: movie for movie in load_modern(args.source_dir)})
    movies = sorted(merged.values(), key=lambda movie: (movie["title"].lower(), movie["year"]))
    add_directors(movies, args.source_dir)
    vectors = encode(movies, args.model_dir)
    centered = vectors - vectors.mean(axis=0)
    _, axes = np.linalg.eigh(centered.T @ centered)
    points = centered @ axes[:, -2:]
    bounds = np.quantile(points, [.01, .99], axis=0)
    positions = np.clip((points - bounds[0]) / (bounds[1] - bounds[0]), 0, 1)
    for movie, point in zip(movies, positions):
        movie["x"], movie["y"] = round(35 + point[0] * 930, 2), round(35 + point[1] * 530, 2)
    output = ROOT / "web/movies/data"
    output.mkdir(parents=True, exist_ok=True)
    (output / "embeddings.f32").write_bytes(vectors.astype("<f4").tobytes())
    info = {"model": MODEL, "revision": REVISION, "dtype": "q8", "dimensions": 384, "pooling": "mean", "batchSize": 1, "maxTokens": 256, "modernCount": sum(movie['source'] == 'original-premise' for movie in movies), "count": len(movies), "movies": movies}
    (output / "catalogue.json").write_text(json.dumps(info, ensure_ascii=True, separators=(",", ":")))
    tokenizer = Tokenizer.from_file(str(args.model_dir / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
    fixtures = []
    for movie in [next(movie for movie in movies if movie['title'] == 'Arrival' and movie['year'] == 2016), next(movie for movie in movies if len(movie['synopsis']) > 1600)]:
        text = f"{movie['title']}. Genres: {', '.join(movie['genres'])}. Tags: {', '.join(movie.get('keywords', []))}. {movie['synopsis']}"
        ids = tokenizer.encode(text).ids
        signature = 2166136261
        for token in ids:
            signature = ((signature ^ token) * 16777619) & 0xffffffff
        fixtures.append({'id': movie['id'], 'title': movie['title'], 'inputTokens': len(ids), 'tokenSignature': f'{signature:08x}'})
    (ROOT / 'catalogue/encoder-fixtures.json').write_text(json.dumps(fixtures, indent=2) + '\n')
    print(json.dumps({"count": len(movies), "known_runtime": sum(movie["runtime"] is not None for movie in movies), "embedding_bytes": vectors.nbytes}), flush=True)


if __name__ == "__main__":
    main()
