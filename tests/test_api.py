import io

from fastapi.testclient import TestClient
from PIL import Image

from typeandsee import api
from typeandsee.core import SearchService
from test_core import FakeCollection, FakeEncoder, FakeMedia


def test_upload_search_and_auth(monkeypatch):
    service = SearchService(FakeEncoder(), FakeCollection(), FakeMedia())
    monkeypatch.setattr(api, "service", lambda: service)
    monkeypatch.setenv("APP_API_TOKEN", "test-secret")
    client = TestClient(api.app)
    assert client.get("/api/search", params={"q": "red bicycle"}).status_code == 401
    image = Image.new("RGB", (8, 8), "red")
    output = io.BytesIO()
    image.save(output, format="PNG")
    headers = {"Authorization": "Bearer test-secret"}
    upload = client.post("/api/images", files={"file": ("bike.png", output.getvalue(), "image/png")},
                         data={"caption": "red bicycle beside a café"}, headers=headers)
    assert upload.status_code == 200
    image_id = upload.json()["id"]
    response = client.get("/api/search", params={"q": "red bicycle"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["results"][0]["id"] == image_id
    assert client.get(f"/api/images/{image_id}", headers=headers).headers["content-type"] == "image/png"
