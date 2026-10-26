import hashlib
import json
import struct

from fastapi.testclient import TestClient

from cubesat_sim.api import create_app
from cubesat_sim.models import default_scenario


def glb_bytes():
    payload = json.dumps({"asset": {"version": "2.0"}}).encode()
    payload += b" " * (-len(payload) % 4)
    return struct.pack("<4sII", b"glTF", 2, 20 + len(payload)) + struct.pack("<I4s", len(payload), b"JSON") + payload


def test_optional_cutaway_preserves_legacy_variants_and_refuses_unlisted_names(tmp_path, monkeypatch):
    data = glb_bytes()
    source = tmp_path / "approved.glb"
    source.write_bytes(data)
    item = {"path": str(source), "revision": "test-v03", "sha256": hashlib.sha256(data).hexdigest()}
    manifest = tmp_path / "models.json"
    manifest.write_text(json.dumps({"dipole": item, "not-approved": item}))
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    with TestClient(create_app()) as client:
        metadata = client.get("/api/assets").json()
        assert set(metadata["variants"]) == {"dipole", "turnstile", "v45"}
        assert metadata["variants"]["dipole"]["available"] is True
        assert set(metadata["previews"]) == {"cutaway", "v45_outward"}
        assert metadata["previews"]["cutaway"]["available"] is False
        assert metadata["previews"]["v45_outward"]["available"] is False
        assert str(tmp_path) not in json.dumps(metadata)
        assert client.get("/api/assets/spacecraft.glb?variant=dipole").content == data
        assert client.get("/api/assets/spacecraft.glb?variant=cutaway").status_code == 422
        assert client.get("/api/assets/spacecraft.glb?variant=v45_outward").status_code == 422
        assert client.get("/api/assets/previews/cutaway.glb").status_code == 404
        assert client.get("/api/assets/previews/v45_outward.glb").status_code == 404
        assert client.get("/api/assets/previews/not-approved.glb").status_code == 422
        assert client.get("/api/assets/previews/../../etc/passwd").status_code == 404


def test_cutaway_is_hash_checked_read_only_and_not_a_scenario_variant(tmp_path, monkeypatch):
    data = glb_bytes()
    source = tmp_path / "cutaway.glb"
    source.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    manifest = tmp_path / "models.json"
    item = {"path": str(source), "revision": "test-v04", "sha256": digest, "label": "Cutaway layout study"}
    manifest.write_text(json.dumps({"cutaway": item}))
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    before = default_scenario().identity()
    with TestClient(create_app()) as client:
        metadata = client.get("/api/assets").json()
        assert metadata["previews"]["cutaway"]["available"] is True
        assert metadata["previews"]["cutaway"]["url"] == "/api/assets/previews/cutaway.glb"
        assert all(not value["available"] for value in metadata["variants"].values())
        response = client.get("/api/assets/previews/cutaway.glb")
        assert response.content == data
        assert response.headers["content-type"] == "model/gltf-binary"
        assert response.headers["etag"] == '"' + digest + '"'
        assert response.headers["x-model-revision"] == response.headers["x-asset-revision"] == "test-v04"
        assert default_scenario().identity() == before
        source.write_bytes(data + b"changed")
        assert client.get("/api/assets/previews/cutaway.glb").status_code == 409
        assert client.get("/api/assets").json()["previews"]["cutaway"]["available"] is False
        # A browser cannot turn a preview into an arbitrary file read.
        for invalid in ({"path": "relative.glb", "sha256": digest}, {"path": str(source), "sha256": "invalid"}, "not-an-object"):
            manifest.write_text(json.dumps({"cutaway": invalid}))
            assert client.get("/api/assets/previews/cutaway.glb").status_code == 404
        monkeypatch.delenv("CUBESAT_MODEL_MANIFEST")
        assert client.get("/api/assets").json()["previews"]["cutaway"]["available"] is True


def test_outward_preview_uses_its_own_allowlisted_hash_checked_entry(tmp_path, monkeypatch):
    data = glb_bytes()
    source = tmp_path / "outward.glb"
    source.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    manifest = tmp_path / "models.json"
    manifest.write_text(json.dumps({"v45_outward": {"path": str(source), "revision": "outward-test", "sha256": digest}}))
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    with TestClient(create_app()) as client:
        metadata = client.get("/api/assets").json()
        assert metadata["previews"]["v45_outward"]["available"] is True
        assert metadata["previews"]["v45_outward"]["url"] == "/api/assets/previews/v45_outward.glb"
        assert metadata["previews"]["cutaway"]["available"] is False
        assert client.get("/api/assets/previews/v45_outward.glb").content == data
        source.write_bytes(data + b"changed")
        assert client.get("/api/assets/previews/v45_outward.glb").status_code == 409
        # A browser cannot turn a preview into an arbitrary file read.
        for invalid in ({"path": "relative.glb", "sha256": digest}, {"path": str(source), "sha256": "invalid"}, "not-an-object"):
            manifest.write_text(json.dumps({"v45_outward": invalid}))
            assert client.get("/api/assets/previews/v45_outward.glb").status_code == 404
        monkeypatch.delenv("CUBESAT_MODEL_MANIFEST")
        assert client.get("/api/assets").json()["previews"]["v45_outward"]["available"] is True
