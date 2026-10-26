# Simulator service 0.1.0

The main mission model couples propagated orbit, rigid-body attitude, limited actuators, RF geometry, solar generation, stored energy and lumped temperatures. Its headless entry is `mission.driver.run_mission(MissionScenario.model_validate(data))`. Results retain the exact inputs, clocks, frame approximations, source hashes, events and energy balance.

The original constructed circular-pass API and CLI remain analytical references with prescribed attitude and ideal threshold capacity. Independent power/thermal and dynamics labs retain separate inputs. The shared mission can optionally account for assumed receiver acquisition and complete DVB frames; this does not establish calibrated receiver reliability, queued packet delivery or operational orbit determination.

Run from the repository after the root setup creates `.venv` and installs this package:

```sh
.venv/bin/python -m cubesat_sim.cli serve
.venv/bin/python -m pytest services/simulator/tests
.venv/bin/python -m cubesat_sim.cli default --output scenario.json
.venv/bin/python -m cubesat_sim.cli run scenario.json --output run.json
```

The service binds `127.0.0.1:8765` through `serve`. The application import for the repository launcher is `cubesat_sim.api:app`. Numerical functions are usable directly as `run_scenario(Scenario.model_validate(data))`; they import no browser or plotting library. `requirements-tested.txt` records the tested environment. Run manifests also retain actual Python/application/FastAPI/Pydantic/uvicorn versions.

## Numerical model map

The Python domains contain the formulas. `mission/driver.py` connects the shared mission; `core.py` retains the constructed circular reference. API routes and browser views consume their returned columns.

| Module                                                                                     | Responsibility and current limit                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geometry/vectors.py`, `geometry/frames.py`                                                | Vector/matrix operations, Hamilton quaternion conversion, WGS84 geodetic/ENU transforms and right-hand rotations.                                     |
| `orbit/gravity.py`, `orbit/elements.py`, `orbit/two_body.py`                               | Central/J2 acceleration and potential, osculating elements, RK4/velocity Verlet, first-order SSO reference and epoch-linked local mean solar time.    |
| `attitude/dynamics.py`, `attitude/control.py`, `attitude/actuators.py`                     | Rigid-body/wheel momentum dynamics, quaternion PD/B-dot references, torque allocation, saturation and actuator electrical/heat ledgers.               |
| `mission/driver.py`, `mission/environment.py`, `mission/ephemeris.py`                      | Shared fixed-clock coupling; approximate Sun/GMST, selected magnetic model, spherical Earth flux and geometric eclipse.                              |
| `geomagnetism/igrf14.py` | Full degree-13 IGRF-14 internal field in ECEF, official coefficients and degree-8 secular variation for 2025–2030. |
| `mission_models.py`, `mission_lab.py`, `mission_jobs.py`, `mission_worker.py`              | Immutable mission inputs, HTTP routes and cancellable process execution.                                                                              |
| `orbit/circular_pass.py`                                                                   | Synthetic point-mass circular pass, constant Earth rotation, endpoint velocities and line-of-sight geometry. No TLE or general propagator.            |
| `attitude/prescribed.py`                                                                   | Kinematic station tracking, prescribed body-axis spin and pointing offset. No actuator, torque or controller solve.                                   |
| `rf/antennas.py`, `rf/polarization.py`                                                     | Analytical vector patterns, normalized source power, horizon feed orientation and reciprocal field coupling.                                          |
| `rf/free_space.py`, `rf/noise.py`                                                          | Free-space attenuation, logarithmic power and antenna-port thermal noise density.                                                                     |
| `rf/modem.py`, `rf/link_budget.py`                                                         | Legacy nominal-rate estimate and direction-specific RF budget, metric, margin and threshold gate. LoRa airtime remains unmodeled.                     |
| `rf/spherical_harmonics.py`, `rf/spherical_harmonic_models.py`, `rf/pattern_provenance.py` | Complex transverse field expansion, strict single-frequency coefficient profiles and recorded source identity.                                        |
| `rf/pattern_sampling.py`                                                                   | Headless pattern-sphere/cut sampling and constant-work field probes using the same antenna formulas as runs.                                          |
| `operations/schedule.py`, `operations/capacity.py`                                         | Half-open alternating slots, requested sample grid and midpoint ideal-capacity integration split at slot boundaries.                                  |
| `operations/radio_delivery.py`, `operations/radio_delivery_models.py`                      | Optional QPSK/8PSK receiver timing, exact DVB frame sizes, scheduled modes and saturated GCS payload/loss counters.                                   |
| `mission/reporting.py`                                                                     | Accepted-interval UTC daily and geometric-pass accounting; no propagation or delivery reconstructed from display samples.                             |
| `validation/mission_refinement.py`                                                         | Bounded process-isolated, one-axis numerical comparisons with exact common timestamps and recorded failures/skips.                                    |
| `power/solar.py`, `power/battery.py`, `power/loads.py`                                     | Projected PV generation, nominal stored-energy balance and electrical/RF/heat accounting. No IV strings or cell-aging model.                          |
| `power/battery_electrical.py`, `power/ncr18650ga_linghu2019.json`                          | Selectable exact-cell 25°C OCV/steady-resistance reference, coulomb balance, terminal limits and battery heat. No RC memory or temperature calibration. |
| `power/radio.py`                                                                           | PA-port RF, transmitter/feed/antenna heat and escaping RF, shared by draft previews and mission power.                                                |
| `thermal/network.py`, `thermal/models.py`                                                  | Lumped conduction, radiation and implicit thermal integration with explicit material/contact inputs.                                                  |
| `power/study.py`, `power/models.py`                                                        | Prescribed CONOPS, manual imaging/eclipse windows, coupled power/thermal bookkeeping and run provenance.                                              |
| `models.py`, `antenna_models.py`                                                           | Immutable validated input contracts and evidence records. `RadioProfile.net_rate_bps()` delegates to `rf/modem.py`.                                   |
| `run_manifest.py`                                                                          | Model/input provenance, runtime versions, constants, validity limits and numerical-source SHA-256 identities.                                         |
| `api.py`, `antenna_lab.py`, `jobs.py`, `worker.py`                                         | HTTP adapters and cancellable job lifecycle. Pattern endpoints contain no pattern equations.                                                          |

`physics.py` temporarily reexports the numerical functions for existing studies; it contains no second implementation. `core.CircularPass`, `core.evaluate_link` and the existing antenna-lab imports also remain compatible. Numerical domains cannot depend on HTTP, worker lifecycle or browser/plotting packages. AST dependency tests and a headless subprocess import guard enforce this direction.

## API

- `POST /api/antenna-lab/reference-request`: `{link, antenna_variant}` returns the exact lab request for an archived mission link.
- `GET /api/mission/default`: provisional one-day dusk SSO scenario.
- `POST /api/mission/orbit`: `{orbit, ltan_hours?, sso?}`. Return linked node metadata; explicit SSO requests update inclination. Ordinary element edits remain free.
- `GET /api/mission/battery-electrical-default`: NCR18650GA reference inputs, primary sources and limits.
- `POST /api/mission/radio-power`: draft TX/RX/idle electrical inputs, downlink and analytical radiation efficiency; returns named RF/heat partitions without running a mission.
- `POST /api/mission/delivery-example`: `{uplink, downlink}`; returns an editable, explicitly illustrative receiver/frame configuration copied from the current DVB radio knobs.
- `GET /api/mission/actuator-presets`: provisional wheel-assisted and magnetic-only spacecraft patches.
- `GET /api/mission/wheel-reference`: manufacturer mechanical references, source identities and the separate assumed wheel-drive budget.
- `POST /api/mission/runs`: `{scenario}`; return an identified job. `GET` and `DELETE /api/mission/runs/{run_id}` inspect or cancel it.
- `POST /api/mission/archive/export`: a raw complete run record, or canonical `{scenario, run}`; returns downloadable archive JSON.
- `POST /api/mission/archive/import`: the raw archive JSON; returns `{snapshot, import_metadata}` after bounded validation.

Mission workers run one at a time, allow two active/queued jobs and retain eight results in memory. Requests are bounded to 30 days. Up to seven days allows 1,000,000 dynamics ticks, 2,000,000 orbit substeps and 100 million reference work units; longer requests require `long_mission` and allow 3,000,000 ticks, 6,000,000 substeps and 300 million work units. All runs retain the 20,001-sample and 64 MiB result limits. The chosen clocks must validate explicitly; the service does not silently coarsen them.

Runs of at most one day have a 180 s wall limit. Longer runs receive a work-dependent limit between 180 s and 3,600 s. This is a resource policy, not a completion estimate or long-term accuracy claim. `status=complete` means worker execution finished; inspect `summary.end_reason` and `computed_duration_s` before treating the requested interval as covered. The UI labels early termination as Stopped.

Progress includes computed time, sample count, execution limits and bounded UTC day summaries under `progress.reporting`. Samples publish only with the immutable completed result; partial sample streaming and resume checkpoints are absent. Final `summary.reporting` contains days and geometric passes with visibility, scheduled/ideal contact, RF estimates and optional frame payload/receiver durations. AOS/LOS remain dynamics-grid resolved, clipped passes are marked, and exact-midnight frame completions belong to the new UTC date. Results retain shared RF, `gnc`, `power` and `thermal` arrays, plus `radio_delivery` when enabled; voltage/current remain null in the energy-only battery model.

Mission archives use format `ssi-coupled-mission`, version 1. `mission_archive.py` checks shape, finite values, sample clocks, completion or stopped-prefix semantics, scenario identity and a SHA-256 digest. The two archive routes permit 64 MiB; ordinary request bodies retain the 512 KiB limit. Histories are bounded to 20,001 samples. Loading does not run a worker or restore the service job cache. Original source hashes remain attached even when the installed implementation has changed. The check establishes structural consistency and integrity, not authenticity or renewed numerical validation.

The digest covers the snapshot serialized with sorted keys, compact separators, ASCII-escaped strings and finite JSON numbers (`ssi-json-v1`). Save and reopen the returned JSON text unchanged: a generic parser can change number spelling and invalidate the digest. The browser retains the raw completed-run response for export, including signed zeros that JavaScript reserialization loses. The service derives its scenario from the archived manifest, without consulting the volatile job cache. Imported runs retain their original validated archive text for subsequent saves. Canonical inline snapshots also permit schema-declared numeric normalization of existing fields; missing fields are never inserted into the archived identity and a hash mismatch is rejected. This version supports the coupled mission schema, not the earlier standalone study results.

The provisional default is three RW1 Type A mechanical references plus an enabled MTQ, with free roll angle and full angular-rate damping. It uses 1 s dynamics, 2 s controller, 10 s thermal/environment and 30 s output clocks. Optional magnetic unloading operates in the wheel-assisted PD branch. It starts disabled, with a provisional 600 s time constant; each wheel has an editable initial relative speed in rpm. Coast disables unloading, and detumble uses B-dot instead. Removing wheels or the MTQ leaves unloading inactive with an explicit status. Disabling actuators removes their torque and associated power, without guessing a mass/inertia correction.

Magnetic unloading requests external torque `−h_w / T`, where `h_w = Σ a_i h_i` is the vector sum of absolute axial wheel momenta. The minimum-norm dipole is `m = (h_w × B) / (T |B|²)`, limited by the configured total dipole norm. Its achieved torque `m × B` can remove only the component perpendicular to the current field. Wheel allocation compensates that achieved torque, then applies each motor's torque, speed and power limits. Controller commands are held between updates; exact compensation is not guaranteed during that interval or under saturation. Individual wheel speeds remain important because a small summed momentum can hide large cancelling momenta in a redundant array. Inputs shorter than the controller interval remain available for experiments but receive a warning: the ideal fixed-field, stationary-body, unsaturated scalar map is `h_next = (1 − Δt_controller/T) h`. It alternates below one controller interval and fails to decay at or below half that interval. This is a reference feedback law, without a general stability or pass-pointing guarantee. The [Hogan and Schaub formulation](https://www.hanspeterschaub.info/PapersPrivate/Hogan2015a.pdf), equations (2), (3), (17) and (21)–(26), gives the wheel momentum and magnetic projection conventions used in the review.

A previously frozen one-day reference, before the current transmitter/delivery additions, completed in 38.31 s; a fresh-process 0.5 s dynamics-only refinement with the same other clocks completed in 67.32 s. At common output times, attitude RMS/max differences were 0.0514°/1.0304°, maximum node-temperature difference was 0.0677 K, battery-trace difference was 0.00290 Wh, and uplink/downlink ideal capacity differed by 0.2893%/0.2979%. The largest attitude difference occurred at a contact transition; events remain dynamics-grid resolved. Total energy closure was below 0.8 µJ. These checks cover this provisional example, not general magnetic tracking stability or the fixed 10 s environment/quadrature fidelity. Magnetic-only cases stopped at explicit angular-step guards and remain comparison studies.

Use the [mission refinement CLI](src/cubesat_sim/validation/README.md) for bounded one-axis comparisons. It records complete inputs, clocks, source identities, shared-time differences and skipped/failed cases. Controller-period changes alter the sampled control system; thermal integration and environment hold refine together in the current model. Neither adjacent differences nor a completed run establish an accuracy bound.

`MissionScenario.magnetic_model` selects `igrf14_degree13` or `igrf14_degree1`. Omitted/null retains the legacy dipole model and original scenario identity for saved runs. New defaults explicitly select degree 13. The [field module](src/cubesat_sim/geomagnetism/README.md) documents the potential, units, frames, coefficients and license. Its 2025 main field uses linear secular variation through 2030, with no date extrapolation. Predictive secular variation is supplied only through degree 8. External disturbance fields, spacecraft magnetic contamination and sensor errors remain absent. The manifest records the selected model and coefficient hash. Body-axis field, applied dipole, requested/achieved torque and residual traces come from the coupled dynamics; the browser only converts display units. In the torque plot, matching colors identify each axis, with dashed requests and solid achieved torque.

The epoch-equatorial Sun/GMST adapter uses UTC as UT1 and omits precession, nutation and EOP. New missions select the full degree-13 IGRF-14 internal field. The separate thermal Earth radius, uniform albedo/IR, fixed concept-cell footprints, 29% covered-footprint efficiency, thermal materials and contacts remain explicit approximations. Imaging windows currently guide the configured common boresight and switch loads; lens FOV and camera-specific image coverage are not solved.

The following routes retain the earlier independent studies:

- `GET /api/power-lab/default`: complete provisional power/thermal inputs.
- `GET /api/power-lab/stage-templates`: validated provisional loads and illumination for Sun pointing, ground tracking, imaging and detumble.
- `POST /api/power-lab/study`: direct `StudyConfig`; returns manifest, columnar samples, stage energy totals, thermal extrema and energy-closure diagnostics. The interactive route limits work to 100,000 node steps.
- `POST /api/power-lab/capacity`: validated battery specification; returns nominal pack energy in Wh.
- `GET /api/health`: service/model versions and local limits.
- `GET /api/scenarios/default`: `{scenario_id, scenario_hash, scenario}` with complete editable inputs and provenance.
- `GET /api/radio-profiles`: editable QPSK 1/2, 8PSK 2/3 and unresolved LoRa templates. Either direction can independently use either waveform.
- `POST /api/runs`, JSON `{ "scenario": <complete Scenario> }`: HTTP 202 and a run record.
- `GET /api/runs/{run_id}`: `{run_id,status,scenario_id,scenario_hash,created_at_utc,result,error}`. `result` is present only for `complete`.
- `DELETE /api/runs/{run_id}`: cancel the owned numerical process, wait for termination, discard incomplete output and remove its temporary files. Completed/failed/cancelled records are unchanged.
- `GET /api/assets`: `{variants:{dipole:{revision,url,label,fallback,sha256,available},turnstile:{...},v45:{...}}}`.
- `GET /api/assets/spacecraft.glb?variant=dipole|turnstile|v45`: serve only the selected, hash-checked operator-configured asset as `model/gltf-binary`.

Set `CUBESAT_MODEL_MANIFEST` to a local JSON file with entries `{ "dipole": { "path": "/absolute/model.glb", "revision": "v02", "sha256": "<64 hex characters>", "label": "...", "fallback": false } }`. No request parameter selects a filesystem path. Missing assets return 404; stale hash identities return 409. Metadata never exposes private paths.

The separate circular-reference queue allows four active/queued jobs, one worker process at a time, 16 retained run records, at most 7,201 requested sample points, 3,600 s per study and a 60 s worker wall-clock budget. Retention is in memory for the current service session. Export a complete result or use the CLI to preserve it. Closing the service cancels active processes. Inputs reject extra fields, nonfinite numbers and out-of-range settings. No user code or shell command is accepted.

A result contains `manifest`, `summary`, `samples` and grid-resolved `events`. `samples` uses equal-length columnar arrays:

```text
time_s, elapsed_ns (decimal strings), utc
satellite_position_m, station_position_m, satellite_position_ecef_m
satellite_velocity_m_s, station_velocity_m_s
q_body_from_inertial_wxyz, range_m, range_rate_m_s
elevation_deg, azimuth_deg, visible, active_direction
attitude_angle_deg, tracking_rate_deg_s
uplink / downlink:
  received_power_dbw, cn0_dbhz, esn0_db, margin_db
  tx_gain_dbi, rx_gain_dbi, fspl_db, noise_density_dbw_hz
  polarization_coupling, polarization_loss_db, doppler_hz
  ideal_rate_bps, cumulative_ideal_bits, valid, reason
```

`attitude_angle_deg` is patch +Y boresight error to the station, not an Euler attitude angle. Margins are counterfactual instantaneous budgets for both directions; only the scheduled direction accumulates capacity. `summary.ideal_capacity_bits[direction]` is **null**, with `capacity_available=false`, if the pattern or receiver threshold is unresolved. Its rates and cumulative values are also null. A known antenna/polarization null, horizon block or negative margin is a physical modeled zero when the model and threshold are otherwise available. Null logarithmic values have a `reason`; no artificial finite floor is drawn through a true antenna field null.

## Original circular-pass geometry, time and attitude

All numerical distances, times and rates use SI; field names retain units. Station coordinates use the WGS84 ellipsoid, but the default 37.4275° N, 122.1697° W and 30 m ellipsoidal height are unsurveyed campus demonstration inputs. The user's Durand-roof station and 1.9 m dish reports do not establish these coordinates or a measured antenna pattern.

The orbit is a point-mass circle of radius `6378137 m + altitude_m`. Its plane is constructed to pass radially above the station at the study midpoint, with the requested Earth-fixed ENU ground-track heading at that midpoint. The inertial velocity is solved at circular speed after adding Earth-rotation velocity; the heading is not an inertial bearing. The 550 km case is a planning example. It has no adopted inclination, RAAN, catalog elements or launch ephemeris. Geodetic up and the station's geocentric radius differ, so the central default slant range is about 558 km and geodetic peak elevation is about 89.81°. This is a declared analytic construction, not a propagated real pass.

`ANALYTIC_INERTIAL` coincides with Earth-fixed XYZ at the pass midpoint. It is **not GCRF or TEME**. The Earth-fixed model uses the WGS84 ellipsoid and constant nominal Earth rotation, including station velocity in range rate and Doppler. No realized ITRF, polar motion, precession/nutation, EOP file, leap-second file or TLE is used. `epoch_utc` labels the first sample; elapsed time is SI seconds with POSIX-like UTC label arithmetic. Nanoseconds serialize as decimal strings. The model is not an astrometric UTC-to-inertial conversion.

Body axes are +X for a straight dipole and patch linear feed, +Y for the patch boresight, and +Z for the second turnstile axis. The quaternion is scalar-first Hamilton `q_body_from_inertial`; `q * [0,v_I] * conjugate(q) = [0,v_B]`. Tracking prescribes +Y to the station and +Z toward projected station north, with an east fallback. `pointing_error_deg` adds a fixed body-X offset. Tumble is a prescribed constant body-axis rotation from the midpoint reference, not rigid-body dynamics or magnetorquer control. Ground ideal az/el tracking uses horizon-horizontal feed `unit(up × LOS)`, a declared projected-east fallback at zenith/nadir, and the editable feed-roll angle. Tracking rate is the geometric LOS angular rate, not achieved hardware performance.

## RF and capacity

`tx_power_w` is available radio/PA output power. The transmit feed loss is applied once before antenna gain. Wanted receive power is available power at a matched antenna terminal. `rx_system_noise_temperature_k` is referred to the same terminal and must include all assumed receive feed/LNA/receiver contributions; a separate receive feed loss is not subtracted again.

With range `r`, frequency `f`, transmit/receive directional gains `Gt`, `Gr` and vector polarization coupling `eta`:

```text
Lfs = 20 log10(4 pi r f / c)
Pr[dBW] = Ptx[dBW] - Ltx + Gt + Gr - Lfs - Lextra + 10 log10(eta)
N0[dBW/Hz] = 10 log10(k Tsys)
C/N0[dB Hz] = Pr - N0
Es/N0[dB] = C/N0 - 10 log10(Rs)
margin[dB] = selected_metric - threshold - engineering_reserve
```

The initial patch is a one-sided analytical cosine-power lobe with an assumed peak gain and linear feed, not an installed patch solution. The wire dipole is a thin, resonant half-wave free-space current surrogate along X. The turnstile is **two orthogonal short dipoles** along X/Z with equal half-power excitation and +90° phase; total power is counted once. Its sphere-average gain is unity before efficiency, with direction-dependent polarization. The wire `spacecraft_peak_gain_dbi` specifies a common radiation-efficiency calibration relative to the ideal half-wave peak, bounded at the shared exact `10 log10(1.640922376984585)` dBi limit (about 2.15088 dBi). Switching to the short-dipole turnstile preserves that efficiency and total source power. Analytical wire geometry is implicitly retuned at the selected frequency; there is no loaded tape-length/resonance solver.

The Sapling-inspired V45 mesh has **no supplied feed/current/installed pattern**, so wire RF and capacity for that variant are unresolved. Choosing a different visible mesh does not make its radiation pattern measured. No GLB mesh is used to derive RF. Ground antenna gain is an independent editable peak with perfect tracking, not a measured dish/Yagi pattern or an aperture model that silently updates with frequency.

Complex Cartesian fields use `exp(+j omega t)`. Receive voltage follows reciprocal bilinear product `F_rx(look-to-source) · E_incident`; the implementation conjugates the receive analyzer before applying a Hermitian polarization inner product. Linear orthogonality, angle-squared coupling, circular-to-linear 1/2, explicit circular analyzers and whole-scene rotation are tested. Polarization is undefined at a true field null.

DVB-S2 QPSK/8PSK threshold templates use [ETSI EN 302 307-1 V1.4.1, section 6, Table 13, printed p. 36](https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf): ideal simulated AWGN performance for normal 64,800-bit FECFRAMEs with perfect carrier/synchronization recovery and no phase noise. The default QPSK 1/2 value is 1.00 dB; 8PSK 2/3 is 6.62 dB. These are not measured receiver/acquisition curves. `net_efficiency` is a separate editable assumption; the legacy RF estimate uses `Rs * bits_per_symbol * code_rate * net_efficiency`. Optional frame accounting below uses exact framing and its own application-overhead boundary. An `ideal_awgn` profile is validated against the cited mode/rate/threshold tuple. Other thresholds must be explicitly illustrative or unresolved.

The optional 438 MHz LoRa template has an unresolved C/N0 threshold and an illustrative 4,800 bit/s information rate. Exact MiniF27 SKU, SX1262/LLCC68 variant, waveform settings and receiver curves remain unresolved. It returns null margin/capacity until a user supplies a labeled illustrative threshold. No sensitivity or packet-success curve is fabricated.

Capacity integrates the ideal net rate only while visible, scheduled and above the selected threshold. The original circular reference evaluates midpoint geometry independently from display samples and splits every schedule boundary exactly. The shared mission integrates on its explicit dynamics clock, with slots constrained to that grid and operation/visibility transitions grid resolved. Visibility and threshold crossings remain grid-resolved. Tests refine the timestep and compare integrated capacity; a result is not a packet count or achieved throughput. The 30 s default slots alternate directions. Simultaneous availability is never inferred from two positive budgets.

## Optional receiver and frame delivery

Set `MissionScenario.radio_delivery` to a validated `RadioDeliveryConfig`; null/omitted keeps the legacy RF results unchanged. Each direction specifies its modes, hardware assumption, decoder threshold source, acquisition/reacquisition time, capture/hold margins, loss timeout, minimum dwell, reconfiguration delay and application overhead. Policies are fixed or scheduled. Scheduled changes finish the current frame, honor dwell, pause for reconfiguration and reacquire; direction/off gaps reset lock and discard partial frames. Feedback-driven ACM remains unimplemented.

`operations/radio_delivery.py` uses the frame sizes and PL symbols from [ETSI EN 302 307-1 V1.4.1](https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf), Tables 5a/5b, printed pp. 22–23; clauses 5.1.5–5.1.6, pp. 18–19; Figure 13/Table 11, p. 31; and clause 5.5.3, p. 33. The saturated generic-continuous-stream model treats each DATA FIELD as one frame-aligned application unit. A frame succeeds only when locked and above the configured decoder step throughout its complete duration. Input C/N0 is held on each accepted interval; within-interval fades require refinement. Rational frame phase and whole-frame batching preserve subdivision at UTC midnight without iterating over millions of frames.

Per-direction samples/summary retain offered, delivered, lost, unresolved and pending useful bits; frame counts; successful acquisitions; lock losses versus planned resets; receiver state/mode; and locked/ready durations. Known model antenna/polarization nulls are resolved outages, without an arbitrary C/N0 floor. Unavailable patterns or unknown thresholds retain explicit unresolved accounting. Reports show null payload for affected days/passes. A run-ending partial is uncredited; frames completed exactly at final midnight can create an endpoint-only day row.

The UI's **RF estimate** retains its original approximate `net_efficiency`; **Frame payload** uses exact DVB framing and explicit application overhead. Neither column is a measurement, and the former is not a universal upper bound on the latter. Offered useful bits bound delivered useful bits within the frame model. No source queue, retries, TS reassembly, Morse ID, downstream throughput bottleneck or calibrated FER/acquisition curve is modeled.

The `esp32_s3_short_pair` option accepts the supported fixed short-frame/pilot combinations at 1 or 5 Msym/s, with 8PSK pairing at 5 Msym/s. Local source revision `f6149796044796f83fe10a27dc381554df21a2d8` documents normal-frame VCM transmission to an E200, while the S3 receiver evidence uses short frames. The paired option therefore rejects scheduled policy; generic scheduled studies remain explicit assumptions. No hardware ACM support is inferred.

## Transmitter planning inputs

The editable user-confirmed example in `power/profiles.py` uses 10 W electrical input and 4 W RF at the radio/PA output, before the feed. `power/radio.py` derives 6 W transmitter heat. The provisional 1 dB feed loss and unit radiation efficiency give approximately 0.82 W feed heat, 3.18 W escaping RF and 6.82 W total spacecraft heat. Antenna loss is additionally retained when radiation efficiency is below unity. These inputs are not a calibrated flight transmitter. Draft previews, the coupled mission and standalone power-study examples share this partition.

## Complex antenna profiles

Antenna Lab accepts `vsh-1` coefficient JSON and can apply it to either mission link. The same Python evaluator supplies the 3D lobe, angular cuts, direction probe and instantaneous link gain/polarization. The original cosine patch remains an explicitly idealized option. Bundled Huygens and multipole examples establish no installed patch performance.

The transverse field and accepted-power gain are

```text
F(θ, φ) = Σₗ₌₁ᴸ Σₘ₌₋ₗˡ [aₗₘ Ψₗₘ(θ, φ) + bₗₘ Xₗₘ(θ, φ)]
Ψₗₘ = ∇ₛYₗₘ / √[l(l + 1)]
Xₗₘ = −i r̂ × Ψₗₘ
G(θ, φ) = 4π η |F(θ, φ)|² / Σₗₘ (|aₗₘ|² + |bₗₘ|²)
```

`Y` uses the orthonormal complex harmonics and Condon–Shortley convention in [NIST DLMF §14.30](https://dlmf.nist.gov/14.30). Colatitude θ is from nominal +Z; azimuth φ runs +X toward +Y. Complex fields use exp(+jωt). The coefficient origin is nominal; it is not a measured phase center. Mount rotation is `Rz(yaw) Ry(pitch) Rx(roll)`. Each profile is valid only at its supplied carrier. Degree is capped at 12; this bound does not establish truncation accuracy for an imported antenna. No frequency extrapolation, solver-specific phase conversion or gain-only reconstruction is performed.

Radiation efficiency η is applied once in gain and also sets escaped RF power in the coupled thermal ledger. It excludes impedance mismatch. The scalar peak-gain control is not used for these profiles. Runs retain the coefficient profile, its SHA-256 identity, source declaration and mount orientation. Source status is supplied metadata, not an independent validation of uploaded data. An installed patch needs a measured or EM-solved full-sphere complex field that includes its mounting, substrate, feed and spacecraft surroundings; adding harmonics alone supplies none of those properties.

## Power and thermal study

`power.study.run_study(StudyConfig.model_validate(data))` runs headlessly. Its separate clock uses prescribed phase boundaries, body-frame Sun directions and optional eclipse/imaging windows. PV extraction, regulator losses, storage losses, escaped RF, component heat, radiation and stored thermal/electrical energy share one first-law ledger. Unused array power remains at the array; it does not become invented regulator heat. Insufficient power produces explicit unserved-load values with proportional bookkeeping, not a claim that a radio operates at partial power.

The selected cell is NCR18650GA. The editable 2S2P example uses minimum charge capacity 3,350 mAh and nominal voltage 3.6 V from [Panasonic’s product table](https://industry.panasonic.eu/pd-130926/batteries/secondary-batteries/lithium-ion-batteries-for-europe/cylindrical-type/ncr-18650ga). Their product gives 48.24 Wh as nominal arithmetic, not guaranteed usable pack energy. This nominal-energy model remains the default. The coupled mission also offers an explicit electrical reference; independent prescribed studies retain the energy-only model. Thermal capacities, conductances, areas, initial temperatures and loads remain explicit provisional inputs. The model cannot yet support a flight-temperature claim.

The external energy balance follows [NASA SmallSat Thermal Control, section 7.1, equation 1](https://www.nasa.gov/smallsat-institute/sst-soa/thermal-control/); projected PV follows [NASA Power Subsystems, section 3.2.1](https://www.nasa.gov/smallsat-institute/sst-soa/power-subsystems/). The implicit thermal solver is checked against analytical equilibrium, conservative pair exchange, energy closure and step refinement. Radiating area covers exterior surfaces; separately supplied Earth IR/albedo irradiance already includes the geometry at those surfaces. Internal radiation exchange coefficients require their own justified geometry.

## Evidence and checks

Each Scenario is frozen and content-addressed from canonical JSON. A change creates a different scenario hash; each Run archives that exact Scenario, runtime/model versions, numerical settings, constants, source locators, warnings and effective-input provenance. `manifest.source_code_hashes` records relative package paths and SHA-256 values for the numerical domains, validated input contracts and run orchestration. An unavailable source file is explicit null; private absolute paths are never included. In the original analytical contract, changed bundled values are tagged as unverified user inputs and results contain a deterministic content hash. The shared mission retains its full frozen input, scenario hash, unique run ID and numerical source identities. Both are independent of camera state. No random inputs are used.

Primary references checked for this implementation:

- [ITU-R P.525-5 (11/2024), section 2.3, equation (5), printed p. 3](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf): free-space attenuation.
- [NGA WGS84 Defining Parameters table](https://earth-info.nga.mil/index.php?action=wgs84&dir=wgs84): equatorial radius, flattening, nominal angular velocity and GM. These constants do not establish an inertial-frame realization.
- [NIST physical constants](https://physics.nist.gov/cuu/Constants/): exact SI speed of light and Boltzmann constant.
- ETSI Table 13 above: ideal threshold conditions only.

The meaningful automated cases cover Friis/noise hand calculations; WGS84 equator/pole and ENU; physical H-feed alignment; 90° quaternion rotation; half-wave axial null and integrated power; turnstile total power and varying polarization; linear/circular limits and global rotation invariance; circular-orbit energy/range-rate and Earth rotation; frozen identities; explicit unresolved results; exact direction-slot integration and timestep refinement; real subprocess completion/cancellation/timeout cleanup; API validation; and allowlisted, hash-checked asset delivery. Installed hardware correlation remains future work.

The extraction regression fixture records baseline revision `ba3ccb7eb13e0aadc07f18fb2584830e555bcd92`, original source hashes, exact inputs and complete-output fingerprints for the default, turnstile-wire and prescribed-tumble histories, plus five pattern/probe cases. Run comparison excludes only runtime versions, the derived result identity and the newly added source identities. Pattern comparison excludes its corrected source-file locator. Scenario and pattern-request JSON Schemas are preserved. These exact-result guards supplement the independent physical reference and convergence tests; they do not establish hardware validity.

## Optional battery electrical reference

`power/battery_electrical.py` uses the 21 NCR18650GA rows in [Linghu et al., Energies 12(7), 1366](https://doi.org/10.3390/en12071366), Table 1, p. 5. The paper characterizes the cell at 25±1°C. We linearly interpolate its relaxed OCV and use `R = R0 + Rp1 + Rp2`, the steady DC sum of its two-RC model. This reduction has no relaxation memory, hysteresis or validated transient response. The runtime JSON retains attribution, exact document hashes and checked locations.

For identical balanced cells, `Qpack = Np Qcell`, `Uoc_pack = Ns Uoc_cell` and `Rpack = Ns Rcell / Np`. Positive current discharges. Coulomb balance gives `dz/dt = -I/Qpack`; terminal voltage is `V = Uoc - I R`. Chemical energy is `Ns Qpack ∫ Uoc_cell(z) dz` above zero SOC. At the 2S2P, 3.35 Ah reference this integral is 49.8883 Wh, distinct from the 48.24 Wh nominal-voltage estimate and from deliverable terminal energy before cutoff.

Each dynamics interval holds current constant and solves its mean terminal power using exact integrals of the piecewise-linear OCV/resistance curves. Voltage limits are checked at both endpoints and every crossed data knot. Current, SOC, voltage, bus power and temperature gates limit charge or discharge; unserved loads stop the coupled mission at its last valid state. Resistive loss `I²R` enters the selected battery thermal node. Legacy charge/discharge efficiencies are ignored only in this model, so storage losses are counted once. The common bus and battery terminals share an ideal reference plane; converters, wiring, imbalance and protection-circuit losses are absent.

The default charge cap is the manufacturer's 1.475 A standard charge procedure, not a maximum rating. Operating gates use 10–45°C charging and −20–60°C discharging from [NCR18650GA document 4J14Z5UTAS](https://www.batteryspace.com/prod-specs/11259-NCR18650GA.pdf), p. 1. OCV and resistance still use the fixed 25°C table outside its reference interval, with an explicit telemetry flag. There is no calibrated hot/cold capacity or resistance map, aging or entropic heat. Capacity and resistance edits are scaling assumptions.

Returned SOC, remaining Ah, OCV and resistance describe sampled state. Terminal voltage, current, power and resistive heat describe the preceding accepted dynamics interval; the initial sample uses the first accepted interval. The run manifest records this convention, the profile digest and all limits. Saved runs preserve the electrical columns. Tests check an independent constant-OCV quadratic, pack scaling, the published integral, all limiting conditions, interval refinement and the complete energy ledger. Turning the electrical option off preserves the legacy scenario identity and numerical histories.


## Preliminary wheel and battery defaults

New coupled missions enable the NCR18650GA 25°C reference at 50% charge SOC. Its OCV-integrated chemical energy is distinct from nominal-voltage energy accounting. Energy-only remains selectable, standalone studies retain their original default, and stored histories are never migrated.

`attitude/wheel_profiles.py` separates manufacturer mechanics from assumed drive behavior. The RW1 Type A reference uses published rotating inertia 694.5e-9 kg·m² and 23 µN·m command torque. The mission chooses an 8000 rpm operational cap and assumes linear motoring taper to zero at that cap. Neither this taper nor Kt, winding resistance or drive efficiency is a calibrated RW1 curve.

The default three-axis running allowance is 0.40 W per axis with a 0.50 W cap. It includes a shared driver budget, derived by summing the manufacturer's per-wheel bounds with one third of its three-wheel driver bound and rounding upward. The current actuator model stores this allowance in `idle_power_w`; this is a budget floor, not measured idle draw. The profile builder accounts for one or two powered axes explicitly. Reapply it when changing installed axis count to retain the whole shared-driver allowance. Sources, hashes, conditions, unknowns and the derived momentum are in the profile metadata. No flight hardware selection or pointing-performance guarantee is implied.
