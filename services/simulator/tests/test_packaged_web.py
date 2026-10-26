"""Same-origin built frontend files without widening the API or file boundary."""
from fastapi.testclient import TestClient
import pytest

from cubesat_sim.api import create_app


@pytest.fixture
def frontend(tmp_path, monkeypatch):
    root = tmp_path / "built frontend"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text('<html><script src="/assets/app.js"></script></html>', encoding="utf-8")
    (root / "assets/app.js").write_text('console.log("packaged");', encoding="utf-8")
    (root / "LICENSE").write_text("Runtime license notice", encoding="utf-8")
    (root / ".env").write_text("PRIVATE_FIXTURE=not exposed", encoding="utf-8")
    (root / "private").mkdir()
    (root / "private/notes.txt").write_text("Private fixture", encoding="utf-8")
    monkeypatch.setenv("CUBESAT_WEB_DIST", str(root))
    return root


def test_real_root_assets_notices_and_head_are_independent_of_cwd(frontend, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with TestClient(create_app()) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.text == (frontend / "index.html").read_text(encoding="utf-8")
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-cache"
        assert client.head("/").content == b""
        script = client.get("/assets/app.js")
        assert script.status_code == 200 and script.text == 'console.log("packaged");'
        assert "javascript" in script.headers["content-type"]
        assert client.get("/LICENSE").text == "Runtime license notice"
        assert client.get("/docs").status_code == 200


def test_missing_files_and_api_errors_keep_their_original_meaning(frontend, monkeypatch):
    monkeypatch.setenv("CUBESAT_LAUNCH_TOKEN", "fixture-launch-identity")
    with TestClient(create_app()) as client:
        health = client.get("/api/health")
        assert health.status_code == 200 and health.json()["status"] == "ok"
        assert health.headers["X-Yapling-Launch-Token"] == "fixture-launch-identity"
        assert "fixture-launch-identity" not in health.text
        assert "X-Yapling-Launch-Token" not in client.get("/").headers
        for path in ("/api", "/api/helath", "/api/runs/no-such-run", "/missing-page", "/assets/missing.js", "/assets/"):
            response = client.get(path)
            assert response.status_code == 404
            assert response.headers["content-type"] == "application/json"
        assert client.get("/api/runs").status_code == 405
        assert client.get("/api/assets/spacecraft.glb?variant=invalid").status_code == 422
        assert client.post("/").status_code == 404


def test_hidden_private_and_traversal_paths_cannot_escape_frontend(frontend, tmp_path):
    (tmp_path / "outside.txt").write_text("Outside fixture", encoding="utf-8")
    with TestClient(create_app()) as client:
        for path in ("/.env", "/.git/config", "/private/notes.txt", "/PRIVATE/notes.txt", "/%2e%2e/outside.txt", "/..%5coutside.txt"):
            response = client.get(path)
            assert response.status_code == 404
            assert "fixture" not in response.text.lower()


def test_symlink_cannot_serve_a_file_outside_frontend(frontend, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("Outside fixture", encoding="utf-8")
    try:
        (frontend / "assets/leak.txt").symlink_to(outside)
    except OSError:
        pytest.skip("Creating symlinks requires additional Windows privileges")
    with TestClient(create_app()) as client:
        assert client.get("/assets/leak.txt").status_code == 404


def test_api_only_mode_and_invalid_frontend_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv("CUBESAT_WEB_DIST", raising=False)
    monkeypatch.delenv("CUBESAT_LAUNCH_TOKEN", raising=False)
    with TestClient(create_app()) as client:
        assert client.get("/").status_code == 404
        assert "X-Yapling-Launch-Token" not in client.get("/api/health").headers
    for directory in ("", "relative/frontend", str(tmp_path)):
        monkeypatch.setenv("CUBESAT_WEB_DIST", directory)
        with pytest.raises(RuntimeError, match="absolute built frontend directory"):
            create_app()
