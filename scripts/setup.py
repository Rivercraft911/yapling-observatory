"""Install local development dependencies into this checkout."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    argparse.ArgumentParser(description=__doc__).parse_args()
    for required in (root / "services/simulator/pyproject.toml", root / "apps/web/package.json"):
        if not required.is_file():
            print(f"Project file is missing: {required}", file=sys.stderr)
            return 1
    if sys.version_info < (3, 11):
        print("Python 3.11 or newer is required.", file=sys.stderr)
        return 1
    npm = shutil.which("npm")
    if npm is None:
        print("Install Node.js and npm before running setup.", file=sys.stderr)
        return 1
    env_dir = root / ".venv"
    python = env_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        venv.create(env_dir, with_pip=True)
    subprocess.run([str(python), "-m", "pip", "install", "-e", "services/simulator[dev]"],
                   cwd=root, check=True)
    web = root / "apps/web"
    subprocess.run([npm, "ci" if (web / "package-lock.json").exists() else "install"],
                   cwd=web, check=True)
    print("Ready. Start with: python3 scripts/dev.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
