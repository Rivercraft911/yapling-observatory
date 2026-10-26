"""Freeze public Python sources and bundled data for one owned subprocess."""
import hashlib
import os
from pathlib import Path
import tempfile

PACKAGE = Path(__file__).resolve().parent
SOURCE_SUFFIXES = {".py", ".json", ".txt"}


def _source_bytes(package):
    sources = {}
    for path in sorted(package.rglob("*")):
        if path.is_symlink():
            raise ValueError("Worker package sources must not contain symlinks")
        if path.is_file() and path.suffix in SOURCE_SUFFIXES:
            sources[path.relative_to(package)] = path.read_bytes()
    if Path("__init__.py") not in sources:
        raise ValueError("Worker package is missing __init__.py")
    return sources


def _hashes(sources):
    return {path: hashlib.sha256(value).hexdigest() for path, value in sources.items()}


def frozen_worker_options(job_directory):
    """Stage a checked copy, then keep package imports ahead of dependency paths."""
    sources = _source_bytes(PACKAGE)
    before = _hashes(sources)
    destination = Path(job_directory) / "worker-source"
    if destination.exists():
        raise ValueError("Worker sources were already prepared for this job")
    with tempfile.TemporaryDirectory(prefix="worker-source-", dir=job_directory) as directory:
        staging = Path(directory)
        package = staging / "cubesat_sim"
        for relative, value in sources.items():
            path = package / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        if before != _hashes(_source_bytes(PACKAGE)) or before != _hashes(_source_bytes(package)):
            raise ValueError("Simulator sources changed while preparing worker; retry after edits finish")
        os.replace(staging, destination)
    environment = os.environ.copy()
    paths = [str(destination)]
    if "PYTHONPATH" in environment:
        paths.extend(os.path.abspath(value) for value in environment["PYTHONPATH"].split(os.pathsep))
    environment["PYTHONPATH"] = os.pathsep.join(paths)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return dict(cwd=str(destination), env=environment)
