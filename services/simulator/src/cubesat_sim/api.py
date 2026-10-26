"""Loopback development API. Long numerical work runs in owned subprocesses."""
from __future__ import annotations

from contextlib import asynccontextmanager
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .antenna_lab import router as antenna_lab_router
from .power_lab import router as power_lab_router
from .dynamics_lab import router as dynamics_lab_router
from .mission_lab import router as mission_router
from .mission_jobs import MissionJobManager
from .live_mission_jobs import LiveMissionJobManager
from .live_mission_lab import router as live_mission_router
from .mission_archive import ARCHIVE_PATHS, MAX_ARCHIVE_BYTES
from .core import MODEL_VERSION
from .jobs import JobManager
from .models import FrozenModel, Scenario, RadioProfile, default_scenario

ASSET_VARIANTS = ("dipole", "turnstile", "v45")
ASSET_PREVIEWS = ("cutaway", "v45_outward")


class RunRequest(FrozenModel):
    scenario: Scenario


def asset_entries(keys=ASSET_VARIANTS):
    """Only an operator-configured private manifest selects filesystem paths."""
    manifest_path = os.environ.get("CUBESAT_MODEL_MANIFEST")
    manifest = {}
    error = None
    try:
        if not manifest_path:
            raise ValueError("Model manifest is not configured")
        source = Path(manifest_path)
        if source.stat().st_size > 262144:
            raise ValueError("Model manifest exceeds size limit")
        manifest = json.loads(source.read_text())
        if not isinstance(manifest, dict):
            raise ValueError("Model manifest must be an object")
    except (OSError, ValueError, TypeError):
        error = "Local model manifest is unavailable or invalid"
    entries = {}
    for variant in keys:
        item = manifest.get(variant, {})
        public = dict(revision=item.get("revision", "unavailable") if isinstance(item, dict) else "unavailable",
                      url=f"/api/assets/previews/{variant}.glb" if variant in ASSET_PREVIEWS else f"/api/assets/spacecraft.glb?variant={variant}",
                      label=item.get("label", variant) if isinstance(item, dict) else variant,
                      fallback=bool(item.get("fallback", False)) if isinstance(item, dict) else False,
                      sha256=item.get("sha256") if isinstance(item, dict) else None, available=False)
        try:
            if error:
                raise ValueError(error)
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise ValueError("Variant is not configured")
            path = Path(item["path"])
            if not path.is_absolute() or path.suffix.lower() != ".glb" or not path.is_file():
                raise ValueError("Configured GLB is unavailable")
            if not 20 <= path.stat().st_size <= 128*1024*1024:
                raise ValueError("Configured GLB size is invalid")
            if not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
                raise ValueError("Configured GLB hash is missing or invalid")
            with path.open("rb") as stream:
                if stream.read(4) != b"glTF":
                    raise ValueError("Configured asset is not a GLB")
                stream.seek(0)
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != item["sha256"]:
                raise ValueError("Configured GLB hash mismatch; refresh the private manifest")
            public["available"] = True
            public["bytes"] = path.stat().st_size
            entries[variant] = (public, path)
        except (OSError, ValueError, TypeError) as exc:
            public["error"] = str(exc) if isinstance(exc, ValueError) else "Configured GLB is unavailable"
            entries[variant] = (public, None)
    return entries


def radio_profiles():
    dvb = default_scenario().downlink.profile
    psk8 = dvb.model_copy(update={"modulation":"8PSK", "code_rate":2/3, "threshold_db":6.62})
    lora = RadioProfile(waveform="lora", modulation="LoRa", information_rate_bps=4800,
                        threshold_metric="cn0", threshold_db=None, threshold_status="unresolved")
    return dict(dvb_s2=dvb.model_dump(mode="json"), lora=lora.model_dump(mode="json"), presets=[
        dict(id="sband-qpsk-half-ideal", label="S-band QPSK 1/2, ideal AWGN threshold", frequency_hz=2.4e9,
             spacecraft_antenna="patch", spacecraft_peak_gain_dbi=6, ground_peak_gain_dbi=31,
             rx_system_noise_temperature_k=150, profile=dvb.model_dump(mode="json")),
        dict(id="sband-8psk-two-thirds-ideal", label="S-band 8PSK 2/3, ideal AWGN threshold", frequency_hz=2.4e9,
             spacecraft_antenna="patch", spacecraft_peak_gain_dbi=6, ground_peak_gain_dbi=31,
             rx_system_noise_temperature_k=150, profile=psk8.model_dump(mode="json")),
        dict(id="uhf-lora-unresolved", label="438 MHz LoRa, receiver threshold unresolved", frequency_hz=438e6,
             spacecraft_antenna="wire", spacecraft_peak_gain_dbi=2.15, ground_peak_gain_dbi=15,
             rx_system_noise_temperature_k=800, profile=lora.model_dump(mode="json")),
    ], notes=["All rates, noise temperatures, powers, gains and net-efficiency inputs are editable examples, not selected hardware.",
              "DVB-S2 thresholds are ideal simulations from ETSI EN 302 307-1 V1.4.1 Table 13, normal FECFRAME, perfect synchronization.",
              "The 4800 bit/s LoRa information rate is illustrative. MiniF27 SKU, receiver threshold, settings and acquisition curves are unresolved.",
              "For an optional assumed LoRa gate enter a C/N0 threshold and mark threshold_status illustrative; no sensitivity curve is fabricated."])


class RequestBodyLimit:
    """Bound actual ASGI body bytes, including chunked requests without length."""
    def __init__(self, app, max_bytes=524288):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        archive_route = (
            scope.get("method") == "POST"
            and path in ARCHIVE_PATHS
            and scope.get("raw_path", path.encode("ascii", errors="replace")) == path.encode("ascii")
        )
        limit = MAX_ARCHIVE_BYTES if archive_route else self.max_bytes
        detail = "Archive body exceeds 64 MiB local limit" if archive_route else "Request body exceeds 512 KiB local limit"
        length = next((value for key,value in scope.get("headers", ()) if key.lower() == b"content-length"), None)
        if length is not None and (not length.isdigit() or len(length) > 20 or int(length) > limit):
            return await JSONResponse({"detail": detail}, status_code=413)(scope, receive, send)
        messages = deque()
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                return await JSONResponse({"detail":"Invalid request body"}, status_code=400)(scope, receive, send)
            total += len(message.get("body", b""))
            if total > limit:
                return await JSONResponse({"detail": detail}, status_code=413)(scope, receive, send)
            messages.append(message)
            if not message.get("more_body", False):
                break
        async def replay_receive():
            return messages.popleft() if messages else await receive()
        return await self.app(scope, replay_receive, send)


def create_app():
    @asynccontextmanager
    async def lifespan(app):
        app.state.jobs = JobManager()
        app.state.mission_jobs = MissionJobManager()
        app.state.live_jobs = LiveMissionJobManager()
        yield
        await app.state.jobs.close()
        await app.state.mission_jobs.close()
        await app.state.live_jobs.close()

    app = FastAPI(title="CubeSat analytical link study", version=__version__, lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"])
    app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])

    app.add_middleware(RequestBodyLimit)
    app.include_router(antenna_lab_router)
    app.include_router(power_lab_router)
    app.include_router(dynamics_lab_router)
    app.include_router(mission_router)
    app.include_router(live_mission_router)

    @app.get("/api/health")
    def health():
        return dict(status="ok", version=__version__, model_version=MODEL_VERSION,
                    mode="local_analytical_example", max_samples=7201, worker_processes=1)

    @app.get("/api/scenarios/default")
    def get_default():
        scenario = default_scenario()
        scenario_id, digest = scenario.identity()
        return dict(scenario_id=scenario_id, scenario_hash=digest, scenario=scenario.model_dump(mode="json"))

    @app.get("/api/radio-profiles")
    def get_profiles():
        return radio_profiles()

    @app.post("/api/runs", status_code=202)
    async def start_run(body: RunRequest, request: Request):
        try:
            return request.app.state.jobs.submit(body.scenario).public()
        except OverflowError as exc:
            raise HTTPException(429, str(exc)) from exc

    def find_job(request, run_id):
        job = request.app.state.jobs.jobs.get(run_id)
        if job is None:
            raise HTTPException(404, "Run not found; local run history is session-scoped")
        return job

    @app.get("/api/runs/{run_id}")
    async def get_run(run_id: str, request: Request):
        return find_job(request, run_id).public()

    @app.delete("/api/runs/{run_id}")
    async def cancel_run(run_id: str, request: Request):
        find_job(request, run_id)
        return (await request.app.state.jobs.cancel(run_id)).public()

    @app.get("/api/assets")
    def get_assets():
        entries = asset_entries(ASSET_VARIANTS + ASSET_PREVIEWS)
        return {"variants":{key:entries[key][0] for key in ASSET_VARIANTS},
                "previews":{key:entries[key][0] for key in ASSET_PREVIEWS}}

    def asset_response(entry):
        public, path = entry
        if path is None:
            raise HTTPException(409 if "hash mismatch" in public.get("error", "") else 404, public.get("error", "Model unavailable"))
        return FileResponse(path, media_type="model/gltf-binary", headers={
            "X-Model-Revision":str(public["revision"]), "X-Asset-Revision":str(public["revision"]),
            "ETag":'"'+public["sha256"]+'"', "Cache-Control":"no-cache", "X-Model-Fallback":str(public["fallback"]).lower(),
        })

    @app.get("/api/assets/spacecraft.glb")
    def get_asset(variant: Literal["dipole", "turnstile", "v45"] = "dipole"):
        return asset_response(asset_entries()[variant])

    @app.get("/api/assets/previews/{preview}.glb")
    def get_preview(preview: Literal["cutaway", "v45_outward"]):
        return asset_response(asset_entries(ASSET_PREVIEWS)[preview])

    return app


app = create_app()
