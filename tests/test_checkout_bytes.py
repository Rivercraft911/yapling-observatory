"""Preserve checked upstream bytes under Windows-style Git checkout settings."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COEFFICIENT_ROOT = Path("services/simulator/src/cubesat_sim/geomagnetism")
LICENSE_ROOT = Path("apps/web/public/licenses")
MODEL_ROOT = Path("services/simulator/src/cubesat_sim/assets/spacecraft")


def recorded_hashes():
    source = json.loads((ROOT / COEFFICIENT_ROOT / "igrf14-source.json").read_text(encoding="utf-8"))
    licenses = json.loads((ROOT / LICENSE_ROOT / "runtime-dependencies.json").read_text(encoding="utf-8"))
    models = json.loads((ROOT / MODEL_ROOT / "manifest.json").read_text(encoding="utf-8"))
    files = {COEFFICIENT_ROOT / source["file"]: source["sha256"]}
    files.update({LICENSE_ROOT / item["license_file"]: item["license_sha256"]
                  for item in [*licenses["packages"], licenses["asset_license"]]})
    files.update({MODEL_ROOT / item["path"]: item["sha256"] for item in models.values()})
    return files


class CheckoutByteTests(unittest.TestCase):
    def test_checked_assets_retain_their_recorded_hashes(self):
        for path, expected in recorded_hashes().items():
            with self.subTest(path=path.as_posix()):
                self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), expected)

    def test_autocrlf_checkout_preserves_coefficients_licenses_and_binary_fixtures(self):
        files = {path: (ROOT / path).read_bytes() for path in recorded_hashes()}
        fixture = Path("services/simulator/tests/fixtures/numerical-extraction-ba3ccb7-payloads.json.gz")
        files[fixture] = (ROOT / fixture).read_bytes()
        files[Path("unprotected-control.txt")] = b"first line\nsecond line\n"
        with tempfile.TemporaryDirectory(prefix="yapling-checkout-") as directory:
            checkout = Path(directory)
            (checkout / ".gitattributes").write_bytes((ROOT / ".gitattributes").read_bytes())
            for path, data in files.items():
                destination = checkout / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)

            def git(*arguments):
                return subprocess.run(
                    ["git", "-c", "core.autocrlf=true", "-c", "core.eol=crlf",
                     "-c", "core.safecrlf=false", *arguments],
                    cwd=checkout, capture_output=True, check=True,
                )

            git("init", "--quiet")
            git("add", "--", ".gitattributes", *(path.as_posix() for path in files))
            for path in files:
                (checkout / path).unlink()
            git("checkout-index", "--all", "--force")
            for path, expected in files.items():
                with self.subTest(path=path.as_posix()):
                    actual = (checkout / path).read_bytes()
                    if path.name == "unprotected-control.txt":
                        self.assertEqual(actual, expected.replace(b"\n", b"\r\n"))
                    else:
                        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
