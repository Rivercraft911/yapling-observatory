# CubeSat Link Simulator

Planning repository for Stanford SSI's antenna, attitude, orbit, and radio-link simulator. Created 2026-10-24 at River's request. No simulator implementation or validated mission-performance result exists yet.

The intended experience combines a detailed, interactive Earth and orbit view with a spacecraft antenna laboratory. A shared simulation timeline connects antenna geometry, polarization, spacecraft motion, ground tracking, radio acquisition, and useful data delivery. Google Earth viewed from space is the user-specified visual benchmark.

## Start here

- [Implementation plan](docs/implementation-plan.md): scope, two teams, staged delivery, and acceptance gates.
- [Model and interface contracts](docs/model-contracts.md): numerical conventions and the boundary between the teams.
- [Visual references and reuse research](docs/research-and-reuse.md): inspected projects, primary references, licenses, and selection decisions.

## User-supplied inputs

| Item | Current input | Status |
| --- | --- | --- |
| High-frequency link | Bidirectional DVB-S2 around 2.4 GHz, QPSK and APSK | Requested scope; exact carriers and supported profiles remain configurable |
| UHF link | 438 MHz starting frequency, editable | Requested scope; radio selection open |
| UHF candidate | NiceRF MiniF27, described as 800 mW | Candidate; SX1262 versus LLCC68 variant must be identified |
| Flight antennas | Dipole, turnstile, tape-measure / bunny-ear forms, patch | Compare designs; geometry and feeding remain inputs |
| Attitude | Uncontrolled tumble and controlled pointing throughout slews; evaluate magnetorquer-only control | Requested scope |
| Ground site | Durand Building roof, Stanford, California | User report; antenna reference-point coordinates and height need survey |
| Ground dish | 1.9 m at 2.4 GHz | User report; gain, pattern, feed, losses, and noise require characterization |
| Ground UHF antenna | Yagi, approximately 15 dBi | User estimate; model, polarization, pattern, and gain reference need confirmation |
| Ground polarization | Believed horizontally linear | Provisional user belief; record separately for each antenna and its mechanical mount |
| Flight polarization | User describes a horizontal dipole or turnstile | Dipole orientation must be defined in spacecraft axes; turnstile polarization depends on feed and viewing direction |

The related SATS workspace describes a 1U vehicle and 550 km circular planning orbit. Inclination and several system allocations are unresolved. These are scenario assumptions, not approved requirements. Previous link studies have conflicting or superseded dish assumptions; the new 1.9 m user report takes precedence for this plan.

## Engineering policy

Keep assumptions, analytical predictions, electromagnetic simulations, and measurements distinguishable. Preserve source revisions, units, reference planes, model limits, and reproduction instructions with each result. Graphics settings and playback speed must not change scientific results. Reuse established libraries with their notices and tested versions; keep mission scenarios separate from the reusable software.

This repository is local. No GitHub repository, remote, or publication is implied.
