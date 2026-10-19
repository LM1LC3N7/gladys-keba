# TODO — KEBA KeContact v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #275, lot 8) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-19): UDP channel on port 7090 (one
      request at a time, pauses, attribution), up to eight stations by IPv4,
      one device per serial, reports 1/2/3, state, plug and cable, power,
      current and voltage per phase, session and total energy (plain
      sensors), current limit, enabled/failsafe/authorization flags (read
      only), allow/forbid buttons and current select behind
      `allow_commands` (off), backoff, port-busy retry, test button, docs
      en/fr, cover. Tested against made-up answers only.
- [x] **Milestone 1 fixes — review** (2026-10-19): "forbid" never held
      back by the channel (I1), last checks in the channel before each send
      (I2), one "curr" a minute (I3), TCH-OK without effect reported (I4),
      late answers quarantined (M1, M2), and M3-M14 (see Decisions).
- [ ] **Milestone 2 — real station**: run against a real P30 x-series and
      c-series, a P20 and a BMW wallbox (see "To check"), turn the answers
      (anonymized) into fixtures. Try `currtime` (volatile current, not on
      P20) instead of `curr` if the flash question below says so.
- [ ] **Milestone 3 — more**: RFID start/stop (`start <tag> <class>`,
      `stop <tag>`) behind the option if users ask, session history
      (reports 1xx), `Setenergy`, display text, phase switching (x2) — each
      behind the option, never a switch.

## To check on a real station

- That the answers really come back through Gladys' Docker bridge (NAT):
  the station answers to port 7090 of the sender; Docker keeps source port
  7090 only when no other flow uses it. Behaviour with Home Assistant or evcc
  talking to the same station from the same host.
- Whether a P30 c-series accepts `ena` and `curr` (the brief says it does
  not; keba-kecontact offers them on every KC P20/P30 and BMW product, see
  Decisions) and what a refused command answers (`TCH-ERR`?).
- The delay the station needs between messages and after `ena 0`
  (keba-kecontact: 100 ms, 2 s), and how long until report 2 shows `ena` /
  `curr` changed.
- `Curr HW` while unplugged (0 on socket models?), `Max curr` vs `Curr user`,
  `E total` resets, `P` in mW.
- `curr` written to flash: is a frequent change harmful? (`currtime` is the
  volatile alternative, not on P20.)
- The DIP switch (DSW1.3) and the x-series web setting named in the docs.
- Docker NAT: MASQUERADE keeps source port 7090? conntrack entry of the
  flow (UDP timeout 30 s / 120 s) against the poll interval; Docker Desktop
  and rootless Docker (port rewritten?).
- evcc (or Home Assistant) setting the failsafe mode of the same station:
  what our reads then show (`Tmo FS`, `Curr FS`), and whether its timeout
  stops a charge allowed by Gladys.
- Whether `ena 0` survives a restart of the station.
- What a P30 c-series answers to `ena` / `curr`: TCH-OK without effect
  (reported by the integration) or TCH-ERR.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-keba:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: keba-kecontact 4.3.1 (MIT, Philipp Danner,
  dannerph/keba-kecontact, commit e9f04eb), the library of Home Assistant's
  KEBA integration — license checked: MIT, not GPL. Cloned read only in
  `_ref/keba-kecontact`. Ported to JavaScript (`src/keba/protocol.js`,
  `src/keba/channel.js`), no Python, no runtime dependency but the SDK; full
  MIT notice in `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`
  (the standard Apache-2.0 text, no name).
- **UDP channel** (`src/keba/channel.js`): one socket bound to 7090 (the
  station answers to port 7090 of the sender, as keba-kecontact binds it);
  ONE request at a time for all stations. Pauses (keba-kecontact's `send`
  and `set_ena`): 100 ms between two messages on the whole channel, and 2 s
  after `ena 0` **for that station only** (the others go on; a station in
  its pause never holds the channel). keba-kecontact waits 100 ms after
  reports too, nothing longer. Among the requests ready to leave, the
  highest priority goes first: "forbid" 2 (its read and its `ena 0`), other
  commands 1, polling 0. A request that can no longer start before its
  `startBy` is rejected LATE, unsent. `beforeSend()` runs right before the
  datagram leaves; when it throws, nothing is sent.
- **Attribution and late answers**: an answer counts only for the request
  in flight, from the IP address asked and of the kind asked (report N, or
  TCH-OK / TCH-ERR); other hosts, push messages and datagrams over 4 KB are
  dropped. After a request went unanswered (timeout, or wait released by a
  "forbid"), the next answer of that kind from that station within 10 s may
  be the late one (M1, M2): dropped when nothing waits, else given as
  `unsure` — an unsure TCH-OK / TCH-ERR is never a confirmation ("sent,
  without confirmation", guard, reads); an unsure report 2 never decides an
  "allow" or a current (refused unsent, "may be a late answer"), never
  updates the state; a "forbid" still sends `ena 0`. Chosen over a `Sec`
  coherence check: `Sec` has a 1 s resolution, a late answer 2 s old could
  pass it.
- **Addresses**: unicast IPv4 only (attribution by source address;
  keba-kecontact requires an IP too): 0/8, 127/8, 224 and above, and
  addresses ending in .255 (broadcast of a home /24) are refused (M10);
  eight at most, never dropped silently. No broadcast discovery (it does not
  cross the Docker bridge).
- **Identity**: report 1 at the first read and every hour; one device per
  serial (`ext:…:keba:<serial>`), never per IP. A report 2 or 3 with another
  serial: identified again (another station at this address); the old
  device becomes "not read any more". A report 2 without serial (M4) is
  read (report 1 named the station) but the commands are refused (read
  only); a report 3 without serial is kept, with another serial dropped.
- **Models** (keba-kecontact's ChargingStationInfo): meter on P30 (not the
  "Deutschland Edition" KC-P30-EC220112-000-DE), on P20 b/c series (version
  ending 10/20/30), not on P20 e-series (01); BMW wallboxes have one. Report 3
  is read only with a meter; when it fails the state is still published.
- **c-series vs x-series** (brief: "a P30 c-series does not drive, an
  x-series does"): **not confirmed by the reference** — keba-kecontact offers
  `ena` and `curr` on every KC P20/P30 and BMW product, and its product
  parsing does not tell c from x series. So nothing is blocked per series
  (the review judged it safe with I4): a product keba-kecontact does not
  recognize is refused unsent; `TCH-ERR` is "refused by the station (model
  or configuration)"; a TCH-OK whose value never leaves its start state, by
  the last read after the command (15 s) or the end of the guard (90 s), is
  logged once (warning) and added to the status ("accepted … without
  applying it: model (c-series?) or setting (DSW1.3, load management)"),
  cleared when a later command of that kind is applied (I4).
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): power,
  current and voltage per phase on `energy-sensor` (W/A/V, instantaneous);
  session energy on `electrical-vehicle-charge/last-charge-energy-added`
  and total energy on `charge-energy-consumption-total` (kWh) — **plain
  sensors, never an index**: the station is behind the main meter, the energy
  tab would count it twice, so the approved index guard of p1-monitor is not
  needed (no `publishEnergyConsumption`, no daily consumption). A total of 0
  is never published. Current limit (`Max curr`) on
  `electrical-vehicle-charge/target-current` (A, read only); connector and
  charging state on `charging-station` (values copied from the core); plug,
  enabled (`Enable sys`, `Enable user`), failsafe (`Tmo FS` > 0) and
  authorization required are `unknown/binary` (vehicle plugged on
  `electrical-vehicle-charge/plugged`). Every role always built (a station
  without meter keeps empty features), so a republished device never loses
  a feature.
- **States**: State 4 → FAULTED; Plug ≥ 5 → OCCUPIED, else AVAILABLE;
  charging state: no vehicle or error → IDLE, 3 → CHARGING, 1/5 →
  PAUSED_BY_CHARGER, 0/2 → EV_CONNECTED. Offline: status "Station
  unreachable", connector UNAVAILABLE, other values kept.
- **Commands** (`allow_commands`, off by default, only `true` allows):
  allow / forbid charging as two `button/push` (value 1 only) sending
  `ena 1` / `ena 0`; the charging current as a `text/select` of whole amperes
  from 6 A to the highest `Curr HW` seen since the start (memory only, not
  in /data; 32 A while unknown — M13), sending `curr <mA>`; never a switch
  nor a writable binary; never `curr 0`; never `failsafe`, `currtime`,
  `start`, `stop`, `unlock`, `x2`.
- **Command rules** (lot 6, wave 2/3 lessons, review): value validated
  strictly; the option checked on arrival and by `beforeSend` right before
  each datagram (the fresh read and the command) leaves, with the start
  (generation) and "no forbid of this station since" (I2); a fresh report 2
  (1.5 s at most) of the same serial decides, never memory; `Enable user`
  missing refuses an "allow" but not a "forbid" (M6: `ena 0` is sent); the
  current refused above `Curr HW` read then, **rounded down to the ampere**
  (M5), or when it is missing; nothing sent when already so (unless a guard
  holds, or for "forbid" on an unsure read); sent within 3.5 s of the click or
  refused unsent, answered by 4.3 s. Outcomes: TCH-OK → success (accepted);
  TCH-ERR → "refused by the station"; silence, wait released or channel
  closed while waiting (M3) → **"sent, without confirmation"** + guard; send
  error → "not sent"; deadline passed in the queue → "link busy" (distinct
  from "station too slow", M7). Reads 3 s and 15 s after, each a NEW read,
  never joining one begun before the command (M12). The ack never waits for
  Gladys.
- **"Forbid charging" first** (I1): never refused for a command in flight;
  on arrival it releases the TCH wait of any other command in flight (that
  command becomes "sent, without confirmation", with its guard); its read
  and `ena 0` go before every other request; an "allow" or a current that
  arrived before it and has not left yet is refused unsent (`beforeSend`).
  Never rate-limited.
- **One `curr` a minute per station** (I3, `TIMINGS.currMinInterval`):
  counted from the send; a change sooner is refused unsent ("Forbid charging
  stays available"); no fine regulation (docs). Flash wear stays in "To
  check", `currtime` in milestone 2.
- **Guards**: after a command that may have been applied, a guard per
  station and kind (ena, curr) keeps the start and wanted states; while it
  holds (a move then the wanted state, or 90 s), a command of that kind is
  always sent. A read equal to the start state never lifts it.
- **RFID start/stop not in v1**: not simple (tag and class to store, the
  station answers something else than TCH-OK, keba-kecontact sends `ena 1`
  first). Noted in milestone 3.
- **Failsafe**: read only (binary). Never written.
- **Port 7090 busy** in the container: status says so, bound again every
  minute (the test button binds at once).
- **Hostile answers**: 4 KB at most; only own fields of a plain object, each
  with its exact type; serials `[0-9A-Za-z]{1,32}`; texts printable and cut
  at 60 characters; the config takes only its known keys; feature ids
  matched by a strict pattern and a fixed role list. Logs carry error kinds
  only.
- **Gladys**: device publications chained, one at a time, each built when
  its turn comes (M11). Reconnection (`connected`): republishes status,
  devices, states and badge (the core keeps them in memory); a changed
  address list or interval restarts the stations. No 429 here (UDP), nothing
  persisted in `/data`.
- **French texts** without English words (M7): "mode de repli" for the
  failsafe mode, "micro-interrupteur DIP"; protocol tokens (`ena`, `curr`,
  `TCH-ERR`, `DSW1.3`) and model names (c-series) kept.
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `energy`**, transport `local`.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests) deleted with `git rm`: no refusal.
- **Review scenarios**: S1, S2, S3, S8, S11 of the reviewer (inverted: they
  showed the faults) and one test per point are in `test/review.test.js`.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #275). No Docker on this PC: the image was not built locally.
