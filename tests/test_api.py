"""
API tests for FastAPI endpoints in backend/server.py
"""

import pytest
from fastapi.testclient import TestClient
from backend.server import app

client = TestClient(app)


def test_api_info():
    response = client.get("/api/info")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert data["status"] == "online"
    assert "local_ips" in data


def test_api_models():
    response = client.get("/api/models")
    assert response.status_code == 200
    data = response.json()
    assert "models" in data
    assert len(data["models"]) > 0
    assert any(m["id"] == "base" for m in data["models"])


def test_api_clean_endpoint():
    response = client.post(
        "/api/clean",
        json={
            "text": "Uuhmmm, this is, uh, working nicely.",
            "remove_vocal_fillers": True,
            "remove_repetitions": True,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["cleaned_text"] == "This is working nicely."
    assert data["removed_count"] == 2
    assert "diff_html" in data


def test_api_history_crud():
    # 1. Add item
    add_resp = client.post(
        "/api/history",
        json={
            "title": "Test Transcript",
            "raw_text": "Uuhmmm test raw speech",
            "cleaned_text": "Test raw speech",
            "removed_count": 1,
            "removed_items": [{"word": "Uuhmmm", "category": "vocal_filler"}],
            "duration_seconds": 3.5,
            "model_name": "base",
            "language": "en",
        },
    )
    assert add_resp.status_code == 200
    item = add_resp.json()
    item_id = item["id"]

    # 2. Get list
    list_resp = client.get("/api/history")
    assert list_resp.status_code == 200
    list_data = list_resp.json()
    assert any(i["id"] == item_id for i in list_data["items"])

    # 3. Toggle favorite
    fav_resp = client.post(f"/api/history/{item_id}/favorite")
    assert fav_resp.status_code == 200

    # 4. Delete item
    del_resp = client.delete(f"/api/history/{item_id}")
    assert del_resp.status_code == 200
