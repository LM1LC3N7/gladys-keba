# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-19

### Added

- KEBA KeContact P20 / P30 (and BMW wallbox) charging stations over their
  local UDP interface (port 7090): one device per serial number with state,
  connector and charging state, vehicle plugged, cable plugged and locked,
  power, current and voltage per phase, energy of the session, total energy
  (plain sensors, never an energy index), maximum current allowed, enabled
  states, failsafe mode (read only) and authorization required.
- Optional commands, off by default: allow / forbid charging (two buttons)
  and the charging current (a select from 6 A to the hardware limit, at most
  once a minute per station), each decided on a fresh report of the station
  and checked again right before it leaves. "Forbid charging" always goes
  first. A command accepted (TCH-OK) but never applied is reported in the
  log and the status.
- One UDP request at a time, at least 100 ms between two messages (2 s for a
  station after its `ena 0`), each answer attributed to its request by source
  address and report kind; a late answer is never taken for a later one.
- "Test the connection" button; English and French guides (UDP interface,
  DIP switch, no authentication on the station).

[Unreleased]: https://github.com/LM1LC3N7/gladys-keba/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-keba/releases/tag/v0.1.1
