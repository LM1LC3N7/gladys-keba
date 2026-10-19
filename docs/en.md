# KEBA KeContact for Gladys

Follow your **KEBA KeContact P20 or P30** charging station (or a BMW wallbox
built on it) in Gladys, through its **local UDP interface** (port 7090),
without any cloud.

> Unofficial integration, **never tested with a real station**: it follows the
> keba-kecontact library (the one of Home Assistant) and KEBA's UDP guide.
> Feedback is welcome. Not affiliated with KEBA.

## What you get

One device per station (identified by its serial number), with:

- the **state** of the station (starting, not ready, ready, charging, error,
  authorization rejected), the **connector** and the **charging state**;
- **plug and cable**: vehicle plugged in, cable plugged at the station, cable
  locked;
- **power** (W), **current** (A) and **voltage** (V) of each phase;
- **energy of the session** and **total energy** (kWh): plain sensors, never
  an index of the energy tab (the station is already behind your meter, it
  would be counted twice);
- **maximum current allowed** (A), **charging enabled** by the station and
  **charging allowed** ("ena"), **failsafe mode** on or off,
  **authorization required** (RFID);
- optionally, three commands (see below).

A station without a built-in meter (P20 e-series, P30 "Deutschland Edition")
gives no power, current, voltage nor energy: these features stay empty.

## 1. Turn the UDP interface on in the station

The UDP interface ("smart home interface") is **off from the factory**. On a
P20 or a P30 c-series, it is turned on with a **DIP switch** inside the
station: according to KEBA's documentation, switch **DSW1.3** set to **ON**
(check the installation manual of your model). On a P30 x-series it is set in
its web interface (the "UDP" / "Smart Home interface" setting).

**Have an electrician do it**: the station must be opened, powered off. Do
not touch the other switches (maximum current, etc.).

The station must be on your network (Ethernet cable) with a **fixed IP
address** (DHCP reservation in your router).

## 2. Configure the integration

1. In Gladys, install the **KEBA KeContact** integration from the store.
2. Enter the **IP address** of the station (an IPv4 address; several
   stations: separate them with commas, eight at most), then save.
3. Open the **Discovery** tab and add the station.

The **Test the connection** button reads every station once.

## Security: no authentication

KEBA's UDP interface **has no authentication**: any device on your local
network can read the station and send it commands, even without Gladys. Keep
the station on a **trusted local network** (never exposed to the Internet,
ideally on a network apart from guests and untrusted devices). Allowing the
commands in Gladys opens nothing more on the station, but lets Gladys (scenes,
AI chat through MCP, Gladys accounts) send them.

## Commands (off by default)

With the **Allow the commands** option:

- **Allow charging** and **Forbid charging**: two buttons that send `ena 1`
  and `ena 0`;
- **Set the charging current**: a list from 6 A to the hardware limit of the
  station (`curr`), **at most once a minute per station**. This is no fine
  regulation (following solar production second by second): the station may
  keep the value in permanent memory, still to check. A change sooner is
  refused unsent; "Forbid charging" stays always available.

Never a switch: a "turn everything off" of a voice assistant or a scene cannot
cut the charge. Before each command the station is read again (report 2) and
the command decided on that read; the current is refused above the hardware
limit read then (`Curr HW`, rounded down to the ampere). The option is checked
again right before the command leaves.

What the answers mean:

- **TCH-OK** means the station **accepted** the command, not that it
  **applied** it. The integration reads the station afterwards; if the value
  never moved, it says so once in the log and in the status ("accepted …
  without applying it"): a model that cannot be driven (c-series?) or a
  setting (DSW1.3, load management of a group of stations).
- **TCH-ERR**: the station refused (model or configuration).
- No answer: "sent, without confirmation"; check the state a few seconds later.
- A product the integration does not recognize (neither KEBA P20/P30 nor
  BMW), or a station that gives no serial number in report 2, refuses the
  commands (read only).

**Forbid charging** always goes first: it does not wait for the answer of
another command in progress (that one becomes "sent, without confirmation"),
and an older "allow" or current never leaves after it. **Forbid stays in
place** until an "Allow charging" (to check: maybe also until the station
restarts): a scene that forbids charging must allow it again too.

"Charging allowed (ena)" shows the state of these two buttons. "Charging
enabled (station)" (`Enable sys`) shows whether the station allows charging
overall: it may stay at 0 with "ena" at 1 for another reason (X1 input, RFID
tag, load management, DIP switches).

The **failsafe mode** is only read: the integration never changes it.
Starting or stopping a session with an RFID tag is not offered.

With the commands allowed, the AI chat of Gladys (MCP) can create and run a
scene that allows or forbids charging.

## Network and Docker

The station answers to **UDP port 7090 of the sender**, whatever port the
question left from. The integration opens port 7090 in its container, on the
Docker network of Gladys (a bridge with NAT). This only works if Docker keeps
source port 7090 on the way out:

- on Linux with "classic" Docker, the translation (MASQUERADE) usually keeps
  the source port when it is free on the host: the expected case;
- with Docker Desktop (Windows, macOS) or rootless Docker, traffic goes
  through a network layer that may change the source port: the answers are
  then lost and the station looks unreachable;
- if another program on the same machine already talks to the station from
  port 7090 (Home Assistant or evcc on the host network, for instance), Docker
  must change the source port and the answers are lost: keep only one.

None of this was checked on a real setup.

## Pace

Each station is read every 30 s by default (10 s to 10 min): report 2 (state),
report 3 (meter), and report 1 (identity) once an hour. One request at a time
for all the stations, at least 100 ms between two messages, and a 2 s pause
for the station that just got `ena 0` (the others go on), as keba-kecontact.
An answer arriving late is never taken for the one of a later request. A
station that stops answering is read again after 30 s, 1, 2 then 5 min; it
shows "Station unreachable".

## Limits

- Never tested with a real station.
- IPv4 addresses only (an answer is attributed to its request by its source
  address).
- No automatic discovery (a broadcast does not cross the Docker network).
- No RFID start, no failsafe setting, no phase switching, no session history
  (reports 1xx).

## Credits

The protocol is ported from **keba-kecontact** (MIT, Philipp Danner), the
library of Home Assistant's KEBA integration. See `THIRD_PARTY_NOTICES.md`.
KEBA and KeContact are trademarks of KEBA AG.
