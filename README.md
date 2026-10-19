# gladys-keba

[Gladys Assistant](https://gladysassistant.com) external integration for
**KEBA KeContact P20 / P30** charging stations (and the BMW wallboxes built on
them), over their **local UDP interface** (port 7090), without any cloud.

Unofficial, **never tested with a real station**. Not affiliated with KEBA.

- State, connector and charging state; vehicle plugged, cable plugged and
  locked; power, current and voltage per phase; energy of the session and
  total energy (plain sensors, never an energy index); maximum current
  allowed, enabled states, failsafe mode, authorization required.
- Optional commands, **off by default**: allow / forbid charging (`ena 1` /
  `ena 0`, two buttons, never a switch; "forbid" always goes first) and the
  charging current (`curr`, a select from 6 A to the hardware limit of the
  station, at most once a minute). TCH-OK means "accepted": a command never
  applied is reported. The failsafe mode is read only.
- **The KEBA UDP interface has no authentication**: keep the station on a
  trusted local network. Turn the interface on first (DIP switch DSW1.3 on a
  P20 / P30 c-series, web interface on a P30 x-series).

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npx --yes github:GladysAssistant/integration-store .
```

Code map:

```
index.js               SDK wiring only
src/handlers.js        SDK handlers -> app
src/app.js             stations, polling, devices, states, status, commands
src/devices.js         device and states of a station (pure)
src/keba/protocol.js   answers, products, reports, command texts (pure)
src/keba/channel.js    the UDP socket: one request at a time, pauses, attribution
src/publisher.js       states to Gladys within 300 per minute
src/config.js          configuration normalized
src/i18n.js            English and French texts
scripts/cover.mjs      cover.png generator (plain Node)
```

## Credits

The KEBA UDP protocol is ported from
[keba-kecontact](https://github.com/dannerph/keba-kecontact) 4.3.1 (MIT,
Philipp Danner), the library of Home Assistant's KEBA integration. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
