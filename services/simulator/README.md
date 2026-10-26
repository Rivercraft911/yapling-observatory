# Numerical service

Python owns the orbit, attitude, RF, power and thermal models. The browser renders returned results. [Model references](REFERENCES.md) map each implementation to its sources, assumptions and checks.

## Run locally

Use Python 3.11 or newer and Node.js 22 or newer. From the repository root:

```sh
python3 scripts/setup.py
python3 scripts/dev.py
```

Open the printed localhost address. Ctrl-C stops both processes. Use `--api-port` and `--web-port` to change ports. The default API reference is at `http://127.0.0.1:8765/docs`.

The bundled spacecraft models work without private files. `CUBESAT_MODEL_MANIFEST` replaces the bundled selection when explicitly set. Relative paths resolve inside that manifest's directory. Absolute paths are available for local operator overrides.

Full simulation requires the Python service. GitHub Pages alone cannot run it.

## Headless use

The shared mission entry point is `mission.driver.run_mission(MissionScenario.model_validate(data))`. Its inputs define orbit, hardware, radio, CONOPS, power, thermal properties and independent numerical clocks. Results retain input and source identities, sampled histories and energy balances.

The original circular-pass reference is also available through the CLI:

```sh
.venv/bin/python -m cubesat_sim.cli default --output scenario.json
.venv/bin/python -m cubesat_sim.cli run scenario.json --output run.json
```

## Verification

```sh
.venv/bin/python -m pytest services/simulator/tests
npm --prefix apps/web run format:check
npm --prefix apps/web run build
python3 scripts/check_third_party_notices.py --build
```

The [CI workflow](../../.github/workflows/checks.yml) lists the browser regression suites. [Numerical refinement](src/cubesat_sim/validation/README.md) compares integration, controller, environment and output resolution. `requirements-tested.txt` records the tested Python environment.

Inputs remain planning assumptions unless their provenance says otherwise. Numerical convergence, conservation checks and reference cases test the implementation. They do not establish calibrated flight hardware or mission performance.
