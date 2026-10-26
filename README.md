# Yapling Observatory

Run a CubeSat mission, inspect antenna lobes, and compare RF, pointing, power and temperatures on one timeline. Follow the spacecraft above Earth or work with its physical model. Resize the panes, choose the lower plots, and replay a computed run at 0.25× to 1000×. Click or drag a plot to scrub. Hover to inspect a sampled value while playback continues. Wheel over a plot to zoom at the pointer; Shift + wheel pans. The linked time window follows you between Earth and Results. Use Full to restore the whole run, or click a daily/pass row to frame that interval. Graphics interpolate between samples for smooth replay.

Python owns the engineering calculations. The browser displays immutable results and handles cameras, geometry and controls. Equations have named homes such as [`rf/free_space.py`](services/simulator/src/cubesat_sim/rf/free_space.py), [`rf/link_budget.py`](services/simulator/src/cubesat_sim/rf/link_budget.py) and [`orbit/gravity.py`](services/simulator/src/cubesat_sim/orbit/gravity.py). See the [model map and numerical guide](services/simulator/README.md).

## Run locally

Use Python 3.11 or newer and Node.js 22 or newer:

```sh
python3 scripts/setup.py
python3 scripts/dev.py
```

Open the printed localhost address. Ctrl-C stops both processes. The launcher accepts `--api-port` and `--web-port`.

Open **Results** for six overview charts, up to twelve selected plots in one to three columns, or UTC daily/pass tables. Results has its own chart preferences; Earth keeps its compact plots. Both share the mission timeline and comparison history. Unresolved payload stays unavailable.

Use **File → Save run** to keep a completed mission, including its original inputs, history and source identities. **Open run…** restores it paused for replay or comparison. Saving uses the computed run even when the controls contain unrun edits. Imported runs are labeled; invalid files leave the current work intact. Archives support up to 64 MiB and 20,001 samples. Their checksum checks file integrity, not the physical validity or authorship of the result.

Mission requests support up to 30 days, subject to explicit work, timestep, output and file-size limits. Week/month requests retain the chosen physics clocks; they do not silently lower fidelity. While a worker runs, the UI shows progress and bounded UTC daily summaries. Completed histories include daily and geometric-pass reports. Batch runs return completed histories. Earth → Live streams a continuous mission separately; durable restart checkpoints are not yet available.

Choose **Earth → Live** to watch the integrator run at 1×–1000× wall speed. Pause holds the entire numerical state. Sun, Ground station and Auto CONOPS commands apply at controller boundaries; Pick target selects an approximate WGS84 imaging location without moving the RF ground station. Commands and a graceful stop are recorded in the final scenario, which can reproduce the saved history. Finish & keep results closes the run; Open in Results imports its checked archive. Discard cancels without creating a completed archive.

Live uses the shared spacecraft and orbit draft. Choose its duration before starting. Mission preset offers **Terminator SSO** and **Daylight passes**. Both start Sun-pointing before a real Stanford tracking opportunity at 50% charge SOC. The terminator preset follows the dusk-ascending SSO seed for 24 hours, with eclipse calculated rather than assumed absent. The daylight pass demo starts Sun-pointing at 50% SOC, before acquisition, with four tracking opportunities above an editable 25° rule and a fifth lower pass that stays Sun-pointing. Its constructed five-orbit sequence includes eclipses and is not a global worst case. Live defaults to a 24-hour horizon so it can continue beyond those five orbits. New live sessions clear prior interactive commands. Speed changes wall pacing. The separate Integration step control records compatible numerical changes at controller boundaries; controller, thermal and output periods stay fixed.

Live telemetry retains a bounded recent tail of real accepted states plus the scheduled archive samples. Temperatures hold between their existing thermal updates. Graphics smooth between returned samples without extrapolating. A disconnected browser pauses the worker after 30 seconds and requires Resume. Sessions remain local to the service process: one active and four retained. Save a completed archive to keep it across restarts. New workers freeze their package sources at launch so subsequent code edits cannot change an active computation.

The spacecraft view includes an optional cutaway with a removable tracker. In Thermal, click a mapped part to select its shared thermal node without moving the camera. Constant optical properties can be edited or filled from a source-labelled reference; these edits apply to the next run, not a running history. Spacecraft CAD and working renders stay in ignored local storage. The viewer reads the allowlisted GLB paths in `private/model-development/web-models.json`. A fresh checkout can run numerical studies without those assets and will report when a physical model is unavailable.

## Model limits

The main mission starts with an editable 24-hour, 550 km dusk-ascending SSO example. Edit a, e, i, Ω, ω and ν directly; LTAN and Ω stay linked at the entered epoch. Choose RK4 or velocity Verlet separately from central or central-plus-J2 gravity. The SSO preset uses a first-order mean-J2 estimate as osculating initial elements. It is a planning case, not a flight ephemeris.

The mission couples rigid-body dynamics, limited wheels and magnetorquers, RF geometry, Sun exposure, battery energy and lumped thermals. The provisional default has three example reaction wheels and an enabled magnetorquer; a magnetic-only comparison preset remains available. Optional magnetic momentum unloading uses the available field-perpendicular torque while the wheels maintain pointing. The starting case leaves it off; GNC controls expose the time constant and initial wheel speeds for comparisons. Coil draw and actuator heat enter the same mission power balance. Ground passes interrupt Sun pointing; manual windows add imaging or detumble. The default reduced-attitude controller leaves roll angle free and damps relative body rates. Moving-boresight feedforward follows the computed ground-target direction and its derivatives; the old stationary-reference option remains available. It does not remove acquisition slews or hardware torque limits. Hardware, mass, inertia, electrical curves and thermal contacts remain provisional. New missions use the full degree-13 IGRF-14 internal magnetic field. GNC also offers the earlier dipole-only reference. Neither includes external magnetic disturbances or sensor errors. A run that reaches a numerical or power limit stops and reports its last valid common state.

The default clocks are 1 s dynamics, 2 s controller, 10 s thermal/environment and 30 s output. The [bounded refinement CLI](services/simulator/src/cubesat_sim/validation/README.md) compares dynamics, orbit substeps, controller period, thermal/environment, Earth quadrature and output sampling. Thermal integration and environment hold currently share one clock. Adjacent differences are diagnostics, not error bounds or a flight-validity claim.

RF uses analytical patterns or single-frequency vector spherical-harmonic profiles, shared by Antenna Lab and mission budgets. Coefficient JSON retains source, efficiency and mount. Bundled harmonic examples and rendered hardware are not validated installed patterns. Display margins are unavailable outside the ground-station mask, while archived raw RF terms remain available for diagnosis. New analytical missions apply the same additional antenna-loss factor to gain and radiated power; harmonic profiles retain their supplied total efficiency. DVB-S2 supports QPSK and 8PSK. A separate UHF LoRa radio beacons while S-band operates; its receiver sensitivity remains an explicit input.

New missions use ideal channel adaptation across the 17 standard normal-frame QPSK/8PSK MODCODs. Fixed mode and scheduled VCM remain selectable. The catalogue uses ETSI EN 302 307-1 V1.4.1 Table 13 AWGN thresholds plus the configured reserve, with explicit acquisition, hold, dwell and reconfiguration assumptions. S-band defaults to 60 seconds TX followed by 5 seconds RX. Frame accounting credits complete GCS frames; current Frame rate and Selected-mode margin are distinct from the fixed-profile RF estimate. The daily/pass reports separate the legacy **RF estimate** from modeled **Frame payload**. They use different rate/overhead assumptions, so the RF estimate is not a universal upper bound. Frame payload assumes a saturated source and explicit application overhead; it does not model traffic queues, retries, TS packet reconstruction, calibrated receiver reliability or feedback-driven ACM. Ground-mount servos and historical weather effects remain unimplemented.

Spacecraft’s Hardware, Power, Thermal and GNC controls edit the same satellite used on Earth. Set mode loads, radio power, solar efficiency, battery configuration and thermal contacts there, then choose **Run on Earth**. Unrun edits leave the displayed history intact. Power exposes cell efficiency directly. Separate Thermal and GNC studies remain under a secondary menu.

The editable transmitter planning example is 10 W DC input and 4 W conducted RF at the PA port. It produces 6 W transmitter heat. With the provisional 1 dB feed loss and unit radiation efficiency, about 3.18 W escapes as RF and 6.82 W becomes heat in the radio chain. Feed and antenna losses remain separate; these are planning inputs, not calibrated flight hardware.

The separate MiniF27 reference sends a 32-byte LoRa beacon every 30 seconds at 438 MHz and 29 dBm. SF11, 125 kHz bandwidth and CR4/5 are editable examples. The adopted current references are 500 mA at 5 V in TX and 6 mA at 3.3 V in RX; no sleep state is used. Feed loss is an editable 1 dB assumption, with an analytical free-space antenna. These are manufacturer-condition planning inputs, not measured whole-board or converter performance. UHF power advances the battery separately across each packet edge before averaging telemetry. Missing receiver sensitivity leaves margin unavailable; a sent beacon is not counted as received. The UHF plots show received level, exact interval duty, transmitted count and mean radio power.

Total dissipation reports internal electrical and actuator heat. Thermal sources shows the individual node inputs, including negative PV extraction at the panel node. Bus node heat is only one part of that ledger. Absorbed radiation and Emitted infrared plots expose the separate environmental heating and cooling terms. Temperature and SOC plots retain returned states; sparse output samples do not resolve every short radio pulse.

New missions enable the NCR18650GA 25 °C electrical reference to compute terminal voltage, current, charge SOC and resistive heat. Energy-only accounting remains selectable, and older histories keep their original model. Published exact-cell OCV and resistance data support this steady-current approximation; it has no transient relaxation, temperature-dependent calibration or aging model. Current and temperature limits constrain operation. Thermal materials and contacts remain provisional. The generic bus uses α = 0.30 and ε = 0.75; the panel node uses 0.90 and 0.85 for both covered cell fronts and petal backs. An optional historical black-anodized reference is available, but no finish has been selected or measured. The current model has no emissivity-versus-temperature curve.

The Power plot group shows generation, requested draw, net available power and charge SOC at the replay cursor. Results also shows whole-run solar energy used, load energy and stored-energy change. Positive available net power can be curtailed by battery limits; it is not automatically stored.

New missions start with three RW1 Type A mechanical references, an assumed linear torque envelope and a 1.20 W running allowance for wheels and their driver, capped at 1.50 W. These editable allowances are budget assumptions, not a measured motor-loss curve. Source values and drive assumptions are available under GNC → Wheels. The current example assumes zero viscous friction and routes actuator heat into the bus node. Speed saturation reduces control authority; it does not represent a motor stall or supply a local wheel/driver temperature.

Static Solar System Scope night lights fade out in daylight and remain an appearance layer. Static NASA clouds supply appearance only. Native-resolution tiles refine close views across the globe; distant views use the global map. The imagery is a historical composite, not simulated weather. Numerical Sun directions drive mission lighting and the visible Sun disk. An amber line marks the returned active Earth-pointing target, separately from the RF station link; shaders never feed calculations.

## Repository

| Path                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `services/simulator/`    | Numerical domains, validated inputs, API and tests         |
| `apps/web/src/earth/`    | Earth rendering and spacecraft-follow camera               |
| `apps/web/src/graphics/` | Shared display and material handling                       |
| `apps/web/src/antenna/`  | Antenna inspection graphics                                |
| `apps/web/src/plots/`    | Selection and display of returned traces                   |
| `apps/web/src/live/`     | Live transport, bounded telemetry display and controls     |
| `apps/web/src/mission/`  | Shared mission inputs, worker state and display adapters   |
| `apps/web/src/systems/`  | Spacecraft study controls and returned power/thermal plots |
| `scripts/`               | Local setup and process lifecycle                          |
| `private/`               | Ignored mission notes, studies, source CAD and renders     |

## Checks

```sh
.venv/bin/python -m pytest services/simulator/tests
npm --prefix apps/web run format:check
npm --prefix apps/web run build
node --experimental-strip-types apps/web/src/live/live-history.test.mjs
node apps/web/src/live/live-lifecycle.test.mjs
node apps/web/src/live/live-target-lifecycle.test.mjs
node --experimental-strip-types apps/web/src/plots/radio-plots.test.mjs
node apps/web/src/mission/mission-uhf-lifecycle.test.mjs
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
node --experimental-strip-types apps/web/src/plots/gnc-plots.test.mjs
node --experimental-strip-types apps/web/src/plots/plot-preferences.test.mjs
node --experimental-strip-types apps/web/src/plots/trace-formatting.test.mjs
node --experimental-strip-types apps/web/src/plots/time-window.test.mjs
node apps/web/src/plots/trace-navigation.test.mjs
node --experimental-strip-types apps/web/src/plots/power-readout.test.mjs
```

Tests cover physical reference cases, numerical regressions and dependency boundaries. The GitHub workflow is configured to run the same checks. Use `npm --prefix apps/web run format` after frontend edits.
