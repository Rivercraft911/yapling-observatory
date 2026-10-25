# Simulator service 0.1.0

This first runnable slice computes an **illustrative analytical circular pass**, prescribed attitude, vector antenna coupling, independent uplink/downlink budgets, and integrated **ideal threshold capacity**. It does not predict mission performance or implement packet delivery, synchronization, receiver lock, acquisition, retries, energy or queues.

Run from the repository after the root setup creates `.venv` and installs this package:

```sh
.venv/bin/python -m cubesat_sim.cli serve
.venv/bin/python -m pytest services/simulator/tests
.venv/bin/python -m cubesat_sim.cli default --output scenario.json
.venv/bin/python -m cubesat_sim.cli run scenario.json --output run.json
```

The service binds `127.0.0.1:8765` through `serve`. The application import for the repository launcher is `cubesat_sim.api:app`. Numerical functions are usable directly as `run_scenario(Scenario.model_validate(data))`; they import no browser or plotting library. `requirements-tested.txt` records the tested environment. Run manifests also retain actual Python/application/FastAPI/Pydantic/uvicorn versions.

## Numerical model map

The Python domains contain the formulas. `core.py` connects them and builds the columnar run; API routes and browser views consume that result.

| Module | Responsibility and current limit |
| --- | --- |
| `geometry/vectors.py`, `geometry/frames.py` | Vector/matrix operations, Hamilton quaternion conversion, WGS84 geodetic/ENU transforms and right-hand rotations. |
| `orbit/circular_pass.py` | Synthetic point-mass circular pass, constant Earth rotation, endpoint velocities and line-of-sight geometry. No TLE or general propagator. |
| `attitude/prescribed.py` | Kinematic station tracking, prescribed body-axis spin and pointing offset. No actuator, torque or controller solve. |
| `rf/antennas.py`, `rf/polarization.py` | Analytical vector patterns, normalized source power, horizon feed orientation and reciprocal field coupling. |
| `rf/free_space.py`, `rf/noise.py` | Free-space attenuation, logarithmic power and antenna-port thermal noise density. |
| `rf/modem.py`, `rf/link_budget.py` | Generic nominal information rate and direction-specific RF budget, metric, margin and ideal rate gate. Exact DVB framing and LoRa airtime remain absent. |
| `rf/pattern_sampling.py` | Headless pattern-sphere/cut sampling and constant-work field probes using the same antenna formulas as runs. |
| `operations/schedule.py`, `operations/capacity.py` | Half-open alternating slots, requested sample grid and midpoint ideal-capacity integration split at slot boundaries. |
| `models.py`, `antenna_models.py` | Immutable validated input contracts and evidence records. `RadioProfile.net_rate_bps()` delegates to `rf/modem.py`. |
| `run_manifest.py` | Model/input provenance, runtime versions, constants, validity limits and numerical-source SHA-256 identities. |
| `api.py`, `antenna_lab.py`, `jobs.py`, `worker.py` | HTTP adapters and cancellable job lifecycle. Pattern endpoints contain no pattern equations. |

`physics.py` temporarily reexports the numerical functions for existing studies; it contains no second implementation. `core.CircularPass`, `core.evaluate_link` and the existing antenna-lab imports also remain compatible. Numerical domains cannot depend on HTTP, worker lifecycle or browser/plotting packages. AST dependency tests and a headless subprocess import guard enforce this direction.

## API

- `GET /api/health`: service/model versions and local limits.
- `GET /api/scenarios/default`: `{scenario_id, scenario_hash, scenario}` with complete editable inputs and provenance.
- `GET /api/radio-profiles`: editable QPSK 1/2, 8PSK 2/3 and unresolved LoRa templates. Either direction can independently use either waveform.
- `POST /api/runs`, JSON `{ "scenario": <complete Scenario> }`: HTTP 202 and a run record.
- `GET /api/runs/{run_id}`: `{run_id,status,scenario_id,scenario_hash,created_at_utc,result,error}`. `result` is present only for `complete`.
- `DELETE /api/runs/{run_id}`: cancel the owned numerical process, wait for termination, discard incomplete output and remove its temporary files. Completed/failed/cancelled records are unchanged.
- `GET /api/assets`: `{variants:{dipole:{revision,url,label,fallback,sha256,available},turnstile:{...},v45:{...}}}`.
- `GET /api/assets/spacecraft.glb?variant=dipole|turnstile|v45`: serve only the selected, hash-checked operator-configured asset as `model/gltf-binary`.

Set `CUBESAT_MODEL_MANIFEST` to a local JSON file with entries `{ "dipole": { "path": "/absolute/model.glb", "revision": "v02", "sha256": "<64 hex characters>", "label": "...", "fallback": false } }`. No request parameter selects a filesystem path. Missing assets return 404; stale hash identities return 409. Metadata never exposes private paths.

The local queue allows four active/queued jobs, one worker process at a time, 16 retained run records, at most 7,201 requested sample points, 3,600 s per study and a 60 s worker wall-clock budget. Retention is in memory for the current service session. Export a complete result or use the CLI to preserve it. Closing the service cancels active processes. Inputs reject extra fields, nonfinite numbers and out-of-range settings. No user code or shell command is accepted.

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

## Geometry, time and attitude

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

DVB-S2 QPSK/8PSK threshold templates use [ETSI EN 302 307-1 V1.4.1, section 6, Table 13, printed p. 36](https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf): ideal simulated AWGN performance for normal 64,800-bit FECFRAMEs with perfect carrier/synchronization recovery and no phase noise. The default QPSK 1/2 value is 1.00 dB; 8PSK 2/3 is 6.62 dB. These are not measured receiver/acquisition curves. `net_efficiency` is a separate editable assumption; rate is `Rs * bits_per_symbol * code_rate * net_efficiency`, not exact DVB framing implementation. An `ideal_awgn` profile is validated against the cited mode/rate/threshold tuple. Other thresholds must be explicitly illustrative or unresolved.

The optional 438 MHz LoRa template has an unresolved C/N0 threshold and an illustrative 4,800 bit/s information rate. Exact MiniF27 SKU, SX1262/LLCC68 variant, waveform settings and receiver curves remain unresolved. It returns null margin/capacity until a user supplies a labeled illustrative threshold. No sensitivity or packet-success curve is fabricated.

Capacity integrates the ideal net rate only while visible, scheduled and above the selected threshold. Midpoint geometry is evaluated independently from display samples and every schedule boundary is split exactly. Visibility and threshold crossings remain grid-resolved. Tests refine the timestep and compare integrated capacity; a result is not a packet count or achieved throughput. The 30 s default slots alternate directions. Simultaneous availability is never inferred from two positive budgets.

## Evidence and checks

Each Scenario is frozen and content-addressed from canonical JSON. A change creates a different scenario hash; each Run archives that exact Scenario, runtime/model versions, numerical settings, constants, source locators, warnings and effective-input provenance. `manifest.source_code_hashes` records relative package paths and SHA-256 values for the numerical domains, validated input contracts and run orchestration. An unavailable source file is explicit null; private absolute paths are never included. Changed bundled values are tagged as unverified user inputs. Results are independent of camera state and contain a deterministic content hash. No random inputs are used.

Primary references checked for this implementation:

- [ITU-R P.525-5 (11/2024), section 2.3, equation (5), printed p. 3](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf): free-space attenuation.
- [NGA WGS84 Defining Parameters table](https://earth-info.nga.mil/index.php?action=wgs84&dir=wgs84): equatorial radius, flattening, nominal angular velocity and GM. These constants do not establish an inertial-frame realization.
- [NIST physical constants](https://physics.nist.gov/cuu/Constants/): exact SI speed of light and Boltzmann constant.
- ETSI Table 13 above: ideal threshold conditions only.

The meaningful automated cases cover Friis/noise hand calculations; WGS84 equator/pole and ENU; physical H-feed alignment; 90° quaternion rotation; half-wave axial null and integrated power; turnstile total power and varying polarization; linear/circular limits and global rotation invariance; circular-orbit energy/range-rate and Earth rotation; frozen identities; explicit unresolved results; exact direction-slot integration and timestep refinement; real subprocess completion/cancellation/timeout cleanup; API validation; and allowlisted, hash-checked asset delivery. Installed hardware correlation remains future work.

The extraction regression fixture records baseline revision `ba3ccb7eb13e0aadc07f18fb2584830e555bcd92`, original source hashes, exact inputs and complete-output fingerprints for the default, turnstile-wire and prescribed-tumble histories, plus five pattern/probe cases. Run comparison excludes only runtime versions, the derived result identity and the newly added source identities. Pattern comparison excludes its corrected source-file locator. Scenario and pattern-request JSON Schemas are preserved. These exact-result guards supplement the independent physical reference and convergence tests; they do not establish hardware validity.
