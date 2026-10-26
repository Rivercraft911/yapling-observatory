"""Enforce headless numerical domains and transport-independent dependency direction."""
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import cubesat_sim
import pytest

PACKAGE = Path(cubesat_sim.__file__).parent
DOMAINS = ("geometry", "attitude", "orbit", "rf", "operations", "power", "thermal", "geomagnetism", "mission")
DOMAIN_IMPORTS = {
    "geometry": {"geometry"},
    "attitude": {"attitude", "geometry"},
    "orbit": {"orbit", "geometry", "attitude", "models"},
    "rf": {"rf", "geometry", "models", "antenna_models"},
    "operations": {"operations"},
    "power": {"power", "thermal", "geometry"},
    "thermal": {"thermal"},
    "geomagnetism": {"geomagnetism"},
    "mission": {"mission", "mission_models", "models", "geometry", "orbit", "attitude", "rf", "operations", "power", "thermal", "geomagnetism"},
}
TRANSPORT_OR_UI = {
    "fastapi", "starlette", "uvicorn", "httpx", "requests", "flask", "django",
    "matplotlib", "plotly", "bokeh", "PIL", "pygame", "tkinter", "PySide6",
    "selenium", "playwright", "webbrowser",
}
TRANSPORT_MODULES = {"api", "antenna_lab", "power_lab", "dynamics_lab", "mission_lab", "mission_jobs", "mission_worker", "jobs", "worker", "cli"}


def module_name(path):
    relative = path.relative_to(PACKAGE).with_suffix("").parts
    if relative[-1] == "__init__":
        relative = relative[:-1]
    return ".".join(("cubesat_sim", *relative))


def imported_modules(path):
    name = module_name(path)
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                yield importlib.util.resolve_name("." * node.level + (node.module or ""), package)
            else:
                yield node.module


def numerical_paths(include_mission=True):
    return sorted(path for domain in DOMAINS if include_mission or domain != "mission" for path in (PACKAGE / domain).rglob("*.py"))


@pytest.mark.parametrize("domain", DOMAINS)
def test_numerical_domain_dependency_direction(domain):
    for path in (PACKAGE / domain).rglob("*.py"):
        for dependency in imported_modules(path):
            parts = dependency.split(".")
            assert parts[0] not in TRANSPORT_OR_UI, (path, dependency)
            if len(parts) > 1 and parts[0] == "cubesat_sim":
                assert parts[1] in DOMAIN_IMPORTS[domain], (path, dependency)
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call):
                assert not (isinstance(node.func, ast.Name) and node.func.id in {"__import__", "eval", "exec"}), path
                assert not (isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"), path


def test_transitive_numerical_dependencies_cannot_reach_transport():
    paths = {module_name(path): path for path in PACKAGE.rglob("*.py")}
    for entry in numerical_paths():
        pending = [module_name(entry)]
        seen = set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            for dependency in imported_modules(paths[name]):
                parts = dependency.split(".")
                assert parts[0] not in TRANSPORT_OR_UI, (entry, name, dependency)
                if parts[0] == "cubesat_sim":
                    assert len(parts) < 2 or parts[1] not in TRANSPORT_MODULES, (entry, name, dependency)
                    if dependency in paths:
                        pending.append(dependency)


def test_compatibility_modules_do_not_duplicate_numerical_formulas():
    from cubesat_sim import antenna_lab, core, physics
    from cubesat_sim.antenna_models import PatternRequest, RunProbe
    from cubesat_sim.orbit.circular_pass import CircularPass
    from cubesat_sim.rf import antennas, modem, pattern_sampling
    from cubesat_sim.models import RadioProfile

    tree = ast.parse((PACKAGE / "physics.py").read_text())
    assert not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for node in ast.walk(tree))
    assert physics.half_wave_dipole is antennas.half_wave_dipole
    assert core.CircularPass is CircularPass
    assert antenna_lab.PatternRequest is PatternRequest
    assert antenna_lab.RunProbe is RunProbe
    assert antenna_lab.sample_pattern is pattern_sampling.sample_pattern
    assert antenna_lab.probe_response is pattern_sampling.probe_response
    model_tree = ast.parse((PACKAGE / "models.py").read_text())
    model_class = next(node for node in model_tree.body if isinstance(node, ast.ClassDef) and node.name == "RadioProfile")
    rate_method = next(node for node in model_class.body if isinstance(node, ast.FunctionDef) and node.name == "net_rate_bps")
    assert len(rate_method.body) == 1 and isinstance(rate_method.body[0], ast.Return)
    call = rate_method.body[0].value
    assert isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "profile_net_rate_bps"
    assert RadioProfile.net_rate_bps.__globals__[call.func.id] is modem.net_rate_bps
    assert all(dependency != "math" for dependency in imported_modules(PACKAGE / "core.py"))
    adapter = ast.parse((PACKAGE / "antenna_lab.py").read_text())
    for endpoint, target in (("pattern", "sample_pattern"), ("probe", "probe_response")):
        function = next(node for node in adapter.body if isinstance(node, ast.FunctionDef) and node.name == endpoint)
        statements = [node for node in function.body if not isinstance(node, ast.Expr)]
        assert len(statements) == 1 and isinstance(statements[0], ast.Return)
        assert isinstance(statements[0].value, ast.Call) and statements[0].value.func.id == target


def test_headless_execution_with_transport_and_ui_imports_blocked():
    script = '''
import importlib.abc
import sys
class BlockTransport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in BLOCKED:
            raise AssertionError('Numerical execution imported ' + fullname)
sys.meta_path.insert(0, BlockTransport())
from cubesat_sim.core import run_scenario
from cubesat_sim.models import Scenario, default_scenario
from cubesat_sim.antenna_models import PatternRequest
from cubesat_sim.rf.pattern_sampling import sample_pattern, probe_response
scenario = default_scenario().model_dump(mode='json')
scenario.update(duration_s=10, step_s=2)
result = run_scenario(Scenario.model_validate(scenario))
assert result['summary']['sample_count'] == 6
request = PatternRequest(polar_steps=12, azimuth_steps=24)
assert sample_pattern(request)['model_version']
assert probe_response(request)
from cubesat_sim.power.study import default_study_config,run_study
assert run_study(default_study_config())['summary']['sample_count'] > 1
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import run_mission
from cubesat_sim.mission_models import MissionScenario
config=default_mission_scenario().model_dump(mode='json')
config['duration_s']=30
assert run_mission(MissionScenario.model_validate(config))['samples']['time_s']==[0,30]
assert not (set(sys.modules) & BLOCKED)
'''
    env = os.environ.copy()
    env["PYTHONPATH"] = str(PACKAGE.parent)
    completed = subprocess.run(
        [sys.executable, "-c", f"BLOCKED={TRANSPORT_OR_UI!r}\n" + script],
        env=env, capture_output=True, text=True, timeout=20,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_run_source_hashes_cover_numerical_domains_and_match_source_bytes():
    from cubesat_sim.run_manifest import source_code_hashes
    expected = {"cubesat_sim/" + path.relative_to(PACKAGE).as_posix() for path in numerical_paths(include_mission=False) if path.relative_to(PACKAGE).parts[0] != "geomagnetism"}
    expected.update("cubesat_sim/" + name for name in ("__init__.py", "core.py", "models.py", "antenna_models.py", "run_manifest.py", "physics.py"))
    hashes = source_code_hashes()
    assert set(hashes) == expected
    for relative, digest in hashes.items():
        assert not Path(relative).is_absolute() and ".." not in Path(relative).parts
        path = PACKAGE.parent / relative
        assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
