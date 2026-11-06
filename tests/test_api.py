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
    assert client.get("/api/search", params={"q": "red bicycle"}).status_code == 200
    image = Image.new("RGB", (8, 8), "red")
    output = io.BytesIO()
    image.save(output, format="PNG")
    headers = {"Authorization": "Bearer test-secret"}
    assert client.post("/api/images", files={"file": ("bike.png", output.getvalue(), "image/png")}).status_code == 401
    upload = client.post("/api/images", files={"file": ("bike.png", output.getvalue(), "image/png")},
                         data={"caption": "red bicycle beside a café"}, headers=headers)
    assert upload.status_code == 200
    image_id = upload.json()["id"]
    response = client.get("/api/search", params={"q": "red bicycle"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["results"][0]["id"] == image_id
    assert client.get(f"/api/images/{image_id}", headers=headers).headers["content-type"] == "image/png"


def test_public_deployment_rejects_upload_without_configured_token(monkeypatch):
    monkeypatch.delenv("APP_API_TOKEN", raising=False)
    monkeypatch.setenv("APP_REQUIRE_UPLOAD_AUTH", "true")
    client = TestClient(api.app)
    response = client.post("/api/images", files={"file": ("image.png", b"test", "image/png")})
    assert response.status_code == 503
