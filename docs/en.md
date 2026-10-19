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
  station (`curr`).

Never a switch: a "turn everything off" of a voice assistant or a scene cannot
cut the charge. Before each command the station is read again (report 2) and
the command decided on that read; the current is refused above the hardware
limit read then (`Curr HW`). A command without an answer is reported "sent,
without confirmation"; a refusal of the station (`TCH-ERR`) is shown as such:
according to KEBA, some models or settings (DIP switches, load management of a
group of stations) refuse these commands. A product the integration does not
recognize (neither KEBA P20/P30 nor BMW) refuses the commands.

The **failsafe mode** is only read: the integration never changes it.
Starting or stopping a session with an RFID tag is not offered.

With the commands allowed, the AI chat of Gladys (MCP) can create and run a
scene that allows or forbids charging.

## Network and Docker

The station answers to **UDP port 7090 of the sender**. The integration opens
this port in its container; the answers come back through the Docker network
of Gladys (NAT) without any setting. If another program on the same machine
already talks to the station from port 7090 (Home Assistant on the host
network, for instance), answers may get lost: use only one of them. This was
not checked on a real setup.

## Pace

Each station is read every 30 s by default (10 s to 10 min): report 2 (state),
report 3 (meter), and report 1 (identity) once an hour. One request at a time,
at least 100 ms between two messages (2 s after `ena 0`), as keba-kecontact.
A station that stops answering is read again after 30 s, 1, 2 then 5 min; it
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
