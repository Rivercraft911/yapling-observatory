# Stanford SSI Link Workspace

Run a CubeSat mission, inspect antenna lobes, and compare RF, pointing, power and temperatures on one timeline. Follow the spacecraft above Earth or work with its physical model. Resize the panes, choose the lower plots, and replay a computed run at 0.25× to 1000×. Click or drag a plot to scrub. Hover to inspect a sampled value while playback continues. Graphics interpolate between samples for smooth replay.

Python owns the engineering calculations. The browser displays immutable results and handles cameras, geometry and controls. Equations have named homes such as [`rf/free_space.py`](services/simulator/src/cubesat_sim/rf/free_space.py), [`rf/link_budget.py`](services/simulator/src/cubesat_sim/rf/link_budget.py) and [`orbit/gravity.py`](services/simulator/src/cubesat_sim/orbit/gravity.py). See the [model map and numerical guide](services/simulator/README.md).

## Run locally

Use Python 3.11 or newer and Node.js 22 or newer:

```sh
python3 scripts/setup.py
python3 scripts/dev.py
```

Open the printed localhost address. Ctrl-C stops both processes. The launcher accepts `--api-port` and `--web-port`.

Use **File → Save run** to keep a completed mission, including its original inputs, history and source identities. **Open run…** restores it paused for replay or comparison. Saving uses the computed run even when the controls contain unrun edits. Imported runs are labeled; invalid files leave the current work intact. Archives support up to 64 MiB and 20,001 samples. Their checksum checks file integrity, not the physical validity or authorship of the result.

The spacecraft view includes an optional cutaway with a removable tracker. Spacecraft CAD and working renders stay in ignored local storage. The viewer reads the allowlisted GLB paths in `private/model-development/web-models.json`. A fresh checkout can run numerical studies without those assets and will report when a physical model is unavailable.

## Model limits

The main mission starts with an editable 24-hour, 550 km dusk-ascending SSO example. Edit a, e, i, Ω, ω and ν directly; LTAN and Ω stay linked at the entered epoch. Choose RK4 or velocity Verlet separately from central or central-plus-J2 gravity. The SSO preset uses a first-order mean-J2 estimate as osculating initial elements. It is a planning case, not a flight ephemeris.

The mission couples rigid-body dynamics, limited wheels and magnetorquers, RF geometry, Sun exposure, battery energy and lumped thermals. The provisional default has three example reaction wheels and an enabled magnetorquer; a magnetic-only comparison preset remains available. Optional magnetic momentum unloading uses the available field-perpendicular torque while the wheels maintain pointing. The starting case leaves it off; GNC controls expose the time constant and initial wheel speeds for comparisons. Coil draw and actuator heat enter the same mission power balance. Ground passes interrupt Sun pointing; manual windows add imaging or detumble. The default reduced-attitude controller leaves roll angle free and damps body rates. Hardware, mass, inertia, electrical curves and thermal contacts remain provisional. Magnetic field uses an IGRF-14 degree-one reference, with no full-field accuracy claim. A run that reaches a numerical or power limit stops and reports its last valid common state.

The one-day reference completes with explicit 1 s dynamics, 2 s controller, 10 s thermal/environment and 30 s output clocks. On the checked local machine it took 38 s; a 0.5 s dynamics-only check took 67 s. Ideal capacity differed by about 0.3% and node temperatures by at most 0.068 K. This checks that example, with contact transitions still grid resolved; it does not validate other inputs or the fixed environment quadrature.

RF uses analytical patterns or single-frequency vector spherical-harmonic profiles, shared by Antenna Lab and mission budgets. Coefficient JSON retains source, efficiency and mount. Bundled harmonic examples are not installed patch predictions. Capacity remains an ideal threshold estimate. DVB-S2 supports QPSK and 8PSK. UHF LoRa has an unresolved receiver threshold. Antenna Lab includes two bent-wire V references and patch half-power cuts; rendered hardware has no validated installed pattern. Acquisition, packet delivery, mount servos and historical weather effects remain unimplemented.

Spacecraft’s Hardware, Power, Thermal and GNC controls edit the same satellite used on Earth. Set mode loads, radio power, solar efficiency, battery configuration and thermal contacts there, then choose **Run on Earth**. Unrun edits leave the displayed history intact. Independent studies remain under a secondary menu.

The NCR18650GA battery defaults to nominal energy accounting. Select its optional 25°C electrical reference to compute terminal voltage, current, remaining charge and resistive heat. Published exact-cell OCV and resistance data support this steady-current approximation; it has no transient relaxation, temperature-dependent calibration or aging model. Current and temperature limits constrain operation. Thermal materials and contacts remain provisional.

Static NASA clouds supply appearance only. Native-resolution tiles refine close views across the globe; distant views use the global map. The imagery is a historical composite, not simulated weather. Numerical Sun directions drive mission lighting; shaders never feed calculations.

## Repository

| Path                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `services/simulator/`    | Numerical domains, validated inputs, API and tests         |
| `apps/web/src/earth/`    | Earth rendering and spacecraft-follow camera               |
| `apps/web/src/graphics/` | Shared display and material handling                       |
| `apps/web/src/antenna/`  | Antenna inspection graphics                                |
| `apps/web/src/plots/`    | Selection and display of returned traces                   |
| `apps/web/src/mission/`  | Shared mission inputs, worker state and display adapters   |
| `apps/web/src/systems/`  | Spacecraft study controls and returned power/thermal plots |
| `scripts/`               | Local setup and process lifecycle                          |
| `private/`               | Ignored mission notes, studies, source CAD and renders     |

## Checks

```sh
.venv/bin/python -m pytest services/simulator/tests
npm --prefix apps/web run format:check
npm --prefix apps/web run build
node --experimental-strip-types apps/web/src/earth/geodesy.test.mjs
node --experimental-strip-types apps/web/src/earth/follow-frames.test.mjs
node apps/web/src/earth/regional-lod.test.mjs
node apps/web/src/earth/cloud-tiles.test.mjs
node --experimental-strip-types apps/web/src/earth/follow-link.test.mjs
node --experimental-strip-types apps/web/src/earth/earth-depth.test.mjs
node --experimental-strip-types apps/web/src/graphics/display-interpolation.test.mjs
node --experimental-strip-types apps/web/src/graphics/frame-size.test.mjs
node --experimental-strip-types apps/web/src/spacecraft/preview-visibility.test.mjs
node --experimental-strip-types apps/web/src/graphics/thermal-overlay.test.mjs
node --experimental-strip-types apps/web/src/mission/mission-requests.test.mjs
node apps/web/src/mission/shared-spacecraft.test.mjs
node --experimental-strip-types apps/web/src/plots/battery-plots.test.mjs
```

Tests cover physical reference cases, numerical regressions and dependency boundaries. The GitHub workflow is configured to run the same checks. Use `npm --prefix apps/web run format` after frontend edits.
