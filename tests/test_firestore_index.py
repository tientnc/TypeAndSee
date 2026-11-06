from typeandsee.firestore_index import FirestoreIndex


class FakeSnapshot:
    def __init__(self, image_id, data):
        self.id = image_id
        self.data = data
        self.exists = data is not None

    def to_dict(self):
        return self.data


class FakeDocument:
    def __init__(self, collection, image_id):
        self.collection = collection
        self.image_id = image_id

    def get(self):
        return FakeSnapshot(self.image_id, self.collection.items.get(self.image_id))

    def set(self, data):
        self.collection.items[self.image_id] = data


class FakeCollection:
    def __init__(self):
        self.items = {}
        self.query_options = None

    def document(self, image_id):
        return FakeDocument(self, image_id)

    def find_nearest(self, **options):
        self.query_options = options
        return self

    def stream(self):
        return [FakeSnapshot(image_id, {**data, "vector_distance": 0.2})
                for image_id, data in self.items.items()]


class FakeClient:
    def __init__(self):
        self.images = FakeCollection()

    def collection(self, name):
        assert name == "images_v1"
        return self.images


def test_firestore_index_roundtrip():
    client = FakeClient()
    index = FirestoreIndex(client)
    assert index.get(["image-1"], include=[])["ids"] == []
    index.upsert(["image-1"], [[1.0, 0.0]], [{"filename": "bike.png"}])
    assert index.get(["image-1"], include=["metadatas"])["metadatas"] == [
        {"filename": "bike.png"}
    ]
    result = index.query([[1.0, 0.0]], 10, include=["metadatas", "distances"])
    assert result["ids"] == [["image-1"]]
    assert result["metadatas"] == [[{"filename": "bike.png"}]]
    assert result["distances"] == [[0.2]]
    assert client.images.query_options["vector_field"] == "embedding"
