#!/usr/bin/env python3
"""Check locked browser dependency notices and optionally the built distribution."""

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="also check apps/web/dist")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    web = root / "apps/web"
    public = web / "public"
    licenses = public / "licenses"
    manifest = json.loads((licenses / "runtime-dependencies.json").read_text())
    lock = json.loads((web / "package-lock.json").read_text())
    runtime = {
        path.removeprefix("node_modules/"): item
        for path, item in lock["packages"].items()
        if path and not item.get("dev")
    }
    recorded = {item["package"]: item for item in manifest["packages"]}
    errors = []
    if runtime.keys() != recorded.keys():
        errors.append("Runtime dependency inventory differs from package-lock.json")
    files = [public / "THIRD_PARTY_NOTICES.txt", licenses / "runtime-dependencies.json"]
    for name, item in recorded.items():
        locked = runtime.get(name, {})
        for field, lock_field in (
            ("version", "version"),
            ("license_id", "license"),
            ("package_url", "resolved"),
            ("package_integrity", "integrity"),
        ):
            if item[field] != locked.get(lock_field):
                errors.append(f"{name}: {field} differs from package-lock.json")
        files.append(licenses / item["license_file"])
    for item in [*recorded.values(), manifest["asset_license"]]:
        path = licenses / item["license_file"]
        if not path.is_file() or sha256(path) != item["license_sha256"]:
            errors.append(f"License missing or changed: {item['license_file']}")
        files.append(path)
    for item in manifest["font_files"]:
        source = web / "node_modules" / item["package"] / "files" / item["file"]
        if source.exists() and sha256(source) != item["sha256"]:
            errors.append(f"Installed font bytes changed: {item['file']}")
    if args.build:
        for source in set(files):
            built = web / "dist" / source.relative_to(public)
            if not built.is_file() or built.read_bytes() != source.read_bytes():
                errors.append(f"Build notice missing or changed: {source.relative_to(public)}")
        assets = web / "dist/assets"
        for item in manifest["font_files"]:
            stem, extension = item["file"].rsplit(".", 1)
            matches = list(assets.glob(f"{stem}-*.{extension}"))
            if len(matches) != 1 or sha256(matches[0]) != item["sha256"]:
                errors.append(f"Built font missing or changed: {item['file']}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"Checked {len(recorded)} runtime package licenses and {len(manifest['font_files'])} font files")
    if args.build:
        print("Build retains the notices, full license texts and original font bytes")


if __name__ == "__main__":
    main()
