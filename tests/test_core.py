import io

from PIL import Image

from typeandsee.core import SearchService, validated_image
from typeandsee.evaluate import evaluate


class FakeEncoder:
    def image(self, image):
        return [1.0, 0.0] if image.getpixel((0, 0))[0] > 100 else [0.0, 1.0]

    def text(self, query):
        return [1.0, 0.0] if "red" in query else [0.0, 1.0]


class FakeCollection:
    def __init__(self):
        self.items = {}

    def get(self, ids, include):
        found = [item for item in ids if item in self.items]
        result = {"ids": found}
        if "metadatas" in include:
            result["metadatas"] = [self.items[item][1] for item in found]
        return result

    def upsert(self, ids, embeddings, metadatas):
        for item, vector, metadata in zip(ids, embeddings, metadatas):
            self.items[item] = (vector, metadata)

    def count(self):
        return len(self.items)

    def query(self, query_embeddings, n_results, include):
        query = query_embeddings[0]
        ranked = sorted(self.items, key=lambda item: -(sum(a * b for a, b in zip(query, self.items[item][0]))))[:n_results]
        return {"ids": [ranked], "metadatas": [[self.items[item][1] for item in ranked]],
                "distances": [[1 - sum(a * b for a, b in zip(query, self.items[item][0])) for item in ranked]]}


class FakeMedia:
    def __init__(self):
        self.items = {}

    def put(self, image_id, raw, extension):
        key = image_id + extension
        self.items[key] = raw
        return key

    def get(self, key):
        return self.items[key]


def make_image(color):
    image = Image.new("RGB", (8, 8), color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_index_search_and_evaluation():
    service = SearchService(FakeEncoder(), FakeCollection(), FakeMedia())
    red = service.add(make_image("red"), "bike.png", "red bicycle by café", "bike")
    blue = service.add(make_image("blue"), "boat.png", "blue boat", "boat")
    assert service.add(make_image("red"), "duplicate.png")["duplicate"]
    trace = []
    results = service.search("red bicycle", 2, trace)
    assert [item["id"] for item in results] == [red["id"], blue["id"]]
    assert service.image_bytes(red["id"])[1] == "image/png"
    assert [step["step"] for step in trace] == ["embedding", "retrieval", "reranking"]
    report = evaluate(service, [{"query": "red bicycle", "relevant_ids": [red["id"]]}], 1)
    assert report["mean_recall_at_k"] == 1.0


def test_rejects_invalid_image():
    try:
        validated_image(b"not an image")
    except ValueError as exc:
        assert "Unsupported" in str(exc)
    else:
        assert False, "Invalid upload accepted"


def test_chroma_persists_and_retrieves(tmp_path):
    import chromadb

    raw = make_image("red")
    first_client = chromadb.PersistentClient(path=str(tmp_path))
    first_collection = first_client.get_or_create_collection(
        "images_v1", metadata={"hnsw:space": "cosine"}
    )
    first = SearchService(FakeEncoder(), first_collection, FakeMedia())
    image_id = first.add(raw, "bike.png", "red bicycle")["id"]
    second_client = chromadb.PersistentClient(path=str(tmp_path))
    second_collection = second_client.get_collection("images_v1")
    second = SearchService(FakeEncoder(), second_collection, FakeMedia())
    assert second.search("red bicycle", 1)[0]["id"] == image_id
