"""Bundled assets remain usable after moving a checkout or installing a package."""
import hashlib
import json
from pathlib import Path
import shutil
import struct

from fastapi.testclient import TestClient
import pytest

from cubesat_sim import api


def glb_bytes():
    payload = json.dumps({"asset": {"version": "2.0"}}).encode()
    payload += b" " * (-len(payload) % 4)
    return struct.pack("<4sII", b"glTF", 2, 20 + len(payload)) + struct.pack("<I4s", len(payload), b"JSON") + payload


def all_metadata(client):
    metadata = client.get("/api/assets").json()
    return {**metadata["variants"], **metadata["previews"]}


def test_all_five_bundled_models_load_from_a_relocated_directory(tmp_path, monkeypatch):
    source = api.DEFAULT_MODEL_MANIFEST.parent
    relocated = tmp_path / "moved package" / "assets" / "spacecraft"
    shutil.copytree(source, relocated)
    manifest = json.loads((relocated / "manifest.json").read_text())
    monkeypatch.setattr(api, "DEFAULT_MODEL_MANIFEST", relocated / "manifest.json")
    monkeypatch.delenv("CUBESAT_MODEL_MANIFEST", raising=False)
    monkeypatch.chdir(tmp_path)
    assert set(manifest) == set(api.ASSET_VARIANTS + api.ASSET_PREVIEWS)
    with TestClient(api.create_app()) as client:
        metadata = all_metadata(client)
        assert str(tmp_path) not in json.dumps(metadata)
        assert "private/" not in json.dumps(manifest)
        for key, item in manifest.items():
            assert not Path(item["path"]).is_absolute()
            assert Path(item["path"]).name == item["path"]
            assert metadata[key]["available"] is True
            response = client.get(metadata[key]["url"])
            assert response.status_code == 200
            data = response.content
            assert len(data) == item["bytes"] == metadata[key]["bytes"]
            assert hashlib.sha256(data).hexdigest() == item["sha256"]
            assert response.headers["etag"] == '"' + item["sha256"] + '"'
            assert response.headers["x-asset-revision"] == item["revision"]
            assert struct.unpack("<4sII", data[:12]) == (b"glTF", 2, len(data))
            size, chunk = struct.unpack("<I4s", data[12:20])
            assert chunk == b"JSON"
            gltf = json.loads(data[20:20 + size])
            assert len(gltf["meshes"]) > 100
            assert all("uri" not in part for category in ("buffers", "images") for part in gltf.get(category, []))
            assert not any(value in data[20:20 + size] for value in (b"/Users/", b"/Volumes/", b"/private/", b"/var/folders/"))


def test_operator_manifest_replaces_defaults_and_resolves_its_own_relative_paths(tmp_path, monkeypatch):
    selected = tmp_path / "operator"
    selected.mkdir()
    data = glb_bytes()
    (selected / "custom.glb").write_bytes(data)
    manifest = selected / "models.json"
    item = {"path": "custom.glb", "revision": "operator-v1", "sha256": hashlib.sha256(data).hexdigest()}
    manifest.write_text(json.dumps({"dipole": item, "unlisted": item}))
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    monkeypatch.chdir(tmp_path)
    with TestClient(api.create_app()) as client:
        metadata = all_metadata(client)
        assert metadata["dipole"]["available"] is True
        assert client.get(metadata["dipole"]["url"]).content == data
        assert all(not value["available"] for key, value in metadata.items() if key != "dipole")
        assert "unlisted" not in metadata
        (selected / "custom.glb").write_bytes(data + b"changed")
        assert client.get(metadata["dipole"]["url"]).status_code == 409
        assert not all_metadata(client)["dipole"]["available"]
        assert "operator-v1" in json.dumps(all_metadata(client))


@pytest.mark.parametrize("contents", ["[]", "not json", " " * 262145, None])
def test_invalid_explicit_manifest_never_falls_back_to_bundled_assets(tmp_path, monkeypatch, contents):
    manifest = tmp_path / "missing-or-invalid.json"
    if contents is not None:
        manifest.write_text(contents)
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    with TestClient(api.create_app()) as client:
        metadata = all_metadata(client)
        assert all(not value["available"] for value in metadata.values())
        assert str(tmp_path) not in json.dumps(metadata)
        assert client.get(metadata["dipole"]["url"]).status_code == 404


def test_empty_explicit_manifest_never_falls_back(monkeypatch):
    monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", "")
    assert all(path is None for _metadata, path in api.asset_entries().values())


@pytest.mark.parametrize("path_kind", ["parent", "symlink", "absolute-bundled"])
def test_relative_paths_cannot_escape_manifest_directory(tmp_path, monkeypatch, path_kind):
    selected = tmp_path / "operator"
    selected.mkdir()
    data = glb_bytes()
    outside = tmp_path / "outside.glb"
    outside.write_bytes(data)
    if path_kind == "symlink":
        try:
            (selected / "linked.glb").symlink_to(outside)
        except OSError:
            pytest.skip("Creating file symlinks is unavailable on this host")
        path = "linked.glb"
    elif path_kind == "parent":
        path = "../outside.glb"
    else:
        path = str(outside)
    manifest = selected / "models.json"
    manifest.write_text(json.dumps({"dipole": {"path": path, "sha256": hashlib.sha256(data).hexdigest()}}))
    if path_kind == "absolute-bundled":
        monkeypatch.delenv("CUBESAT_MODEL_MANIFEST", raising=False)
        monkeypatch.setattr(api, "DEFAULT_MODEL_MANIFEST", manifest)
    else:
        monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", str(manifest))
    public, resolved = api.asset_entries()["dipole"]
    assert resolved is None
    assert not public["available"]
    assert str(tmp_path) not in json.dumps(public)


def test_missing_bundled_manifest_is_reported_without_private_lookup(tmp_path, monkeypatch):
    monkeypatch.delenv("CUBESAT_MODEL_MANIFEST", raising=False)
    monkeypatch.setattr(api, "DEFAULT_MODEL_MANIFEST", tmp_path / "missing.json")
    assert all(path is None for _metadata, path in api.asset_entries().values())
