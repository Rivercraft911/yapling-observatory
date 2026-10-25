# Mission refinement checks

Run from the repository root with the project Python environment:

```sh
.venv/bin/python -m cubesat_sim.validation.mission_refinement --output /tmp/ssi-pass-refinement
```

This runs a constructed 1,200 s circular overhead pass using the current editable planning inputs. It enables the explicitly limited 25 °C NCR18650GA reference and uses 0.5 s dynamics so three levels fit the other clocks. The case is a numerical check, not a catalog pass or calibrated spacecraft prediction.

Use an existing complete MissionScenario JSON, or the current mission preset:

```sh
.venv/bin/python -m cubesat_sim.validation.mission_refinement --scenario scenario.json --axes dynamics,thermal_environment --levels 3 --output /tmp/ssi-custom-refinement
.venv/bin/python -m cubesat_sim.validation.mission_refinement --default-mission --duration-s 21600 --axes thermal_environment,output --levels 2 --output /tmp/ssi-six-hour-refinement
```

Each axis changes only its declared setting: dynamics step, orbit substeps, controller sampling period, combined thermal/environment time step, Earth-disk angular quadrature, or output sampling. Controller changes are physical sampled-control sensitivity studies. Thermal integration and environment hold share one current clock and cannot be separated by this tool. Invalid clock combinations and duplicate/budget-limited levels are explicitly skipped.

The default budget is 250,000 total dynamics ticks, 50,000 output rows, 24 cases, 120 s per case and 600 s total scheduling time; cleanup and bounded report serialization add overhead. Each case runs in a separate process with a hard wall timeout and 64 MiB result-size limit. CLI options can lower limits or explicitly increase tick/time limits within supported bounds. Output directories must be new; existing results are never overwritten.

`report.json` retains the scenarios, source identities, solver clocks, work estimates, wall times, end reasons, skipped/failed cases, file checksums and comparisons. Individual case files contain full immutable Run results. Cases with changed numerical source identities remain recorded and are excluded from controlled-refinement comparisons. Comparisons use exact common timestamps without interpolation: quaternion geodesic/body-rate differences, battery/thermal traces, ordered event signatures/timing and integrated ideal-capacity differences. Output-only refinement should preserve selected shared-time physics and integrated summaries exactly. New reporting metadata is excluded from that equality check.

Adjacent differences are diagnostics rather than accuracy bounds. A contact transition can move to a different dynamics tick, change a held controller command and prevent monotonic differences. `decrease_not_demonstrated` does not mean the finer grid is less accurate. The tool infers neither integrator order nor flight validity. Stopped prefixes and missing levels remain visible.
