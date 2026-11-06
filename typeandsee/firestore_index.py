"""Firestore adapter with the subset of Chroma's collection API used by SearchService."""


class FirestoreIndex:
    def __init__(self, client=None):
        if client is None:
            from google.cloud import firestore

            client = firestore.Client()
        self.collection = client.collection("images_v1")

    def get(self, ids, include):
        found = []
        metadata = []
        for image_id in ids:
            snapshot = self.collection.document(image_id).get()
            if snapshot.exists:
                found.append(image_id)
                if "metadatas" in include:
                    data = snapshot.to_dict()
                    metadata.append({key: value for key, value in data.items() if key != "embedding"})
        result = {"ids": found}
        if "metadatas" in include:
            result["metadatas"] = metadata
        return result

    def upsert(self, ids, embeddings, metadatas):
        from google.cloud.firestore_v1.vector import Vector

        for image_id, embedding, metadata in zip(ids, embeddings, metadatas):
            self.collection.document(image_id).set({**metadata, "embedding": Vector(embedding)})

    def query(self, query_embeddings, n_results, include):
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        from google.cloud.firestore_v1.vector import Vector

        query = self.collection.find_nearest(
            vector_field="embedding",
            query_vector=Vector(query_embeddings[0]),
            distance_measure=DistanceMeasure.COSINE,
            limit=n_results,
            distance_result_field="vector_distance",
        )
        snapshots = list(query.stream())
        ids, metadatas, distances = [], [], []
        for snapshot in snapshots:
            data = snapshot.to_dict()
            ids.append(snapshot.id)
            distances.append(float(data["vector_distance"]))
            metadatas.append({key: value for key, value in data.items()
                              if key not in {"embedding", "vector_distance"}})
        return {"ids": [ids], "metadatas": [metadatas], "distances": [distances]}
