# Stanford SSI Link Workspace

Explore a CubeSat pass, inspect antenna lobes, and compare uplink and downlink budgets. Follow the spacecraft above Earth or work with its physical model. Resize the panes, choose the lower plots, and replay a computed run at 0.25× to 1000×. Click or drag a plot to scrub. Hovering leaves playback alone.

Python owns the engineering calculations. The browser displays immutable results and handles cameras, geometry and controls. Equations have named homes such as [`rf/free_space.py`](services/simulator/src/cubesat_sim/rf/free_space.py), [`rf/link_budget.py`](services/simulator/src/cubesat_sim/rf/link_budget.py) and [`orbit/circular_pass.py`](services/simulator/src/cubesat_sim/orbit/circular_pass.py). See the [model map and numerical guide](services/simulator/README.md).

## Run locally

Use Python 3.11 or newer and Node.js 22 or newer:

```sh
python3 scripts/setup.py
python3 scripts/dev.py
```

Open the printed localhost address. Ctrl-C stops both processes. The launcher accepts `--api-port` and `--web-port`.

Spacecraft CAD and working renders stay in ignored local storage. The viewer reads the allowlisted GLB paths in `private/model-development/web-models.json`. A fresh checkout can run numerical studies without those assets and will report when a physical model is unavailable.

## Model limits

The current pass is a constructed circular example with prescribed tracking or tumble. RF uses analytical vector patterns and ideal threshold capacity. DVB-S2 supports QPSK and 8PSK. UHF LoRa is separate, with an unresolved receiver threshold. The V/tape mesh has no validated installed radiation pattern.

Real orbit forecasts, physical attitude control, hardware receiver behavior, power and thermal histories remain planned. Bundled station and radio values are examples with inspectable provenance. Earth imagery and shader lighting do not affect the calculations.

## Repository

| Path | Purpose |
| --- | --- |
| `services/simulator/` | Numerical domains, validated inputs, API and tests |
| `apps/web/src/earth/` | Earth rendering and spacecraft-follow camera |
| `apps/web/src/graphics/` | Shared display and material handling |
| `apps/web/src/antenna/` | Antenna inspection graphics |
| `apps/web/src/plots/` | Selection and display of returned traces |
| `scripts/` | Local setup and process lifecycle |
| `private/` | Ignored mission notes, studies, source CAD and renders |

## Checks

```sh
.venv/bin/python -m pytest services/simulator/tests
npm --prefix apps/web run format:check
npm --prefix apps/web run build
node --experimental-strip-types apps/web/src/earth/geodesy.test.mjs
node --experimental-strip-types apps/web/src/earth/follow-frames.test.mjs
node apps/web/src/earth/regional-lod.test.mjs
```

Tests cover physical reference cases, numerical regressions and dependency boundaries. The GitHub workflow is configured to run the same checks. Use `npm --prefix apps/web run format` after frontend edits.
