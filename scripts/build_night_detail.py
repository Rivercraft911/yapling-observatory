"""Reproduce the checked native night-light artwork; requires Pillow 12.3.0."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="NASA BlackMarble_2016_A1_geo_gray.tif")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "apps/web/public/earth/night-detail.json").read_text())
    source_bytes = args.source.read_bytes()
    if (
        len(source_bytes) != manifest["source_bytes"]
        or hashlib.sha256(source_bytes).hexdigest() != manifest["source_sha256"]
    ):
        raise ValueError("Source identity mismatch")
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(args.source) as source:
        if list(source.size) != manifest["source_dimensions"]:
            raise ValueError("Source dimensions mismatch")
        georeferencing = manifest["source_georeferencing"]
        if (
            tuple(source.tag_v2[33550]) != tuple(georeferencing["model_pixel_scale"])
            or tuple(source.tag_v2[33922]) != tuple(georeferencing["model_tiepoint"])
        ):
            raise ValueError("Source georeferencing mismatch")
        channels = source.crop(tuple(manifest["crop_pixel_box"])).split()
        if len(channels) != 3 or not (
            channels[0].tobytes() == channels[1].tobytes() == channels[2].tobytes()
        ):
            raise ValueError("Source is not equal-channel grayscale")
        grayscale = channels[0]
        output = args.output or root / "apps/web/public/earth" / manifest["file"]
        grayscale.save(output, "WEBP", lossless=True, method=6, exact=True)
        with Image.open(output) as decoded:
            if decoded.convert("L").tobytes() != grayscale.tobytes():
                raise ValueError("Lossless pixel round trip failed")
        encoded = output.read_bytes()
        if (
            len(encoded) != manifest["runtime_bytes"]
            or hashlib.sha256(encoded).hexdigest() != manifest["runtime_sha256"]
        ):
            raise ValueError("Encoded identity differs; use recorded Pillow/libwebp versions")
        print(f"Verified {output}: {len(encoded)} bytes, source pixels preserved exactly")


if __name__ == "__main__":
    main()
