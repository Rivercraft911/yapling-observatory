"""Reproduce the display-only NASA cloud coverage maps; requires Pillow 12.3.0."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, features


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def coverage_lut(toe_code):
    result = []
    for code in range(256):
        t = min(1, code / toe_code)
        result.append(math.floor(code * t * t * (3 - 2 * t) + 0.5))
    return result


def box_mean(rows):
    horizontal = [math.floor(sum(row) / len(row) + 0.5) for row in rows]
    return math.floor(sum(horizontal) / len(horizontal) + 0.5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("--output-directory", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    public = args.output_directory or root / "apps/web/public/earth"
    public.mkdir(parents=True, exist_ok=True)
    native = json.loads((root / "apps/web/public/earth/cloud-tiles.json").read_text())
    manifest = json.loads((root / "apps/web/public/earth/cloud-global.json").read_text())
    transfer = native["display_transfer"]
    lut = coverage_lut(transfer["toe_code"])
    checks = []
    Image.MAX_IMAGE_PIXELS = None
    global8 = Image.new("L", (8192, 4096))
    scale = 21600 / 4096
    for index, side in enumerate(("W", "E")):
        expected = native["sources"][index]
        source = args.source_directory / f"cloud.{side}.2001210.21600x21600.png"
        if source.stat().st_size != expected["source_bytes"] or sha256(source) != expected["source_sha256"]:
            raise ValueError(f"{side} source identity mismatch")
        with Image.open(source) as image:
            if image.size != (21600, 21600) or image.mode != "L":
                raise ValueError("Source shape mismatch")
            coverage = image.point(lut)
            half = coverage.resize((4096, 4096), Image.Resampling.BOX)
            for x, y in [(100,100), (3230,1329), (3300,1425), (3500,1450), (4090,3500)]:
                box = tuple(math.floor(value * scale + 0.5) for value in (x,y,x+1,y+1))
                footprint = image.crop(box)
                codes = list(footprint.tobytes())
                rows = [codes[i:i+footprint.width] for i in range(0,len(codes),footprint.width)]
                remapped_rows = [[lut[code] for code in row] for row in rows]
                predicted = box_mean(remapped_rows)
                observed = half.getpixel((x,y))
                if predicted != observed:
                    raise ValueError(f"Independent source footprint mismatch: {side} {(x,y)} {predicted} != {observed}")
                checks.append(dict(hemisphere=side, reduced_pixel=[x,y], source_box=list(box),
                    source_code_rows=rows, transformed_box_mean=predicted, observed_reduced_code=observed))
            global8.paste(half, (index * 4096, 0))
            half.close()
            coverage.close()
        print(f"{side}: verified original, remapped native texels, BOX-reduced", flush=True)
    global4 = global8.resize((4096, 2048), Image.Resampling.BOX)
    for level, image in [("8k",global8), ("4k",global4)]:
        entry = manifest["maps"][level]
        path = public / entry["file"]
        image.save(path, "WEBP", lossless=True, quality=75, method=4, exact=True)
        with Image.open(path) as decoded:
            channels = decoded.convert("RGB").split()
            if any(ImageChops.difference(image, channel).getextrema() != (0,0) for channel in channels):
                raise ValueError("Lossless coverage round trip failed")
        for channel in channels:
            channel.close()
        entry.update(runtime_bytes=path.stat().st_size, runtime_sha256=sha256(path))
        entry["validation"]["comparison"] = "Complete decode equals soft-toe-before-BOX coverage, not original display-image codes"
        print(f"{level}: {path.stat().st_size} bytes, {entry['runtime_sha256']}", flush=True)
    manifest["revision"] = "nasa-blue-marble-cloud-2001-global-soft-toe-v2"
    manifest["derived_utc"] = datetime.now(timezone.utc).isoformat()
    manifest["display_transfer"] = transfer
    manifest["transform"] = (
        "Verify each original NASA grayscale hemisphere, apply the documented 256-code pointwise "
        "display-only soft-toe LUT to native texels, then BOX-reduce each hemisphere to4096square "
        "and join W then E into8192x4096. BOX-reduce that result2x2 to4096x2048. Encode lossless WebP. "
        "No geographic painting, synthetic clouds, sharpening or gap filling. The remap precedes "
        "all spatial reduction; runtime does not apply a second transfer to these global coverage values."
    )
    manifest["processing"].update(pillow=Image.__version__, libwebp=features.version("webp"),
        coverage_lut_sha256=hashlib.sha256(bytes(lut)).hexdigest(),
        filter_order_checks=checks,
        filter_order_check_rounding="Pillow BOX integer source footprint; horizontal round-half-up then vertical round-half-up",
        peak_native_decode="One native L source and one remapped L hemisphere at a time, about890MiB before decoder/encoder overhead; never both native hemispheres")
    transfer_limit = (
        "The display-only soft toe attenuates genuine faint clouds as well as low-gray mosaic plateaus. "
        "Codes64..255 remain unchanged; R8 quantization and lossy native-tile compression remain. "
        "This is not calibrated cloud fraction, optical depth, gamma correction or weather; bright "
        "source discontinuities and the longitude0 seam are not repaired."
    )
    if transfer_limit not in manifest["limits"]:
        manifest["limits"].append(transfer_limit)
    global8.close()
    global4.close()
    text = json.dumps(manifest,indent=2,ensure_ascii=False) + "\n"
    (public / "cloud-global.json").write_text(text)
    if public == root / "apps/web/public/earth":
        (root / "apps/web/src/earth/cloud-global.json").write_text(text)
    print("Verified native-before-filter source footprints and encoded map identities", flush=True)


if __name__ == "__main__":
    main()
