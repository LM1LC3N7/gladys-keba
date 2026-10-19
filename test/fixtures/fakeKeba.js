// -----------------------------------------------------------------------------
// Fake KEBA stations behind a fake UDP socket: the reports shaped like
// keba-kecontact's emulator and tests (made up, never captured from a real
// station), and the commands "ena" and "curr", which change the station like
// they are expected to. Records every datagram sent. No network. Delays use
// setTimeout, so the mocked clock drives them; answers arrive on
// setImmediate.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.60';
export const SERIAL = '22501234';
export const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);

/** Report 1 of a P30 x-series. */
export const report1 = (over = {}) => ({
  ID: '1',
  Product: 'KC-P30-EC240422-E00',
  Serial: SERIAL,
  Firmware: 'P30 v 3.10.16 (211025-071420)',
  'COM-module': 1,
  Backend: 0,
  timeQ: 3,
  Sec: 1000,
  ...over,
});

/** Report 2: a vehicle charging, 16 A asked of 32 A, enabled. */
export const report2 = (over = {}) => ({
  ID: '2',
  State: 3,
  Error1: 0,
  Error2: 0,
  Plug: 7,
  AuthON: 0,
  Authreq: 0,
  'Enable sys': 1,
  'Enable user': 1,
  'Max curr': 16000,
  'Max curr %': 1000,
  'Curr HW': 32000,
  'Curr user': 16000,
  'Curr FS': 0,
  'Tmo FS': 0,
  'Curr timer': 0,
  'Tmo CT': 0,
  Setenergy: 0,
  Output: 0,
  Input: 0,
  'X2 phaseSwitch source': 0,
  'X2 phaseSwitch': 0,
  Serial: SERIAL,
  Sec: 1000,
  ...over,
});

/** Report 3: three phases at 16 A, 11 kW, 5.25 kWh this session, 1234.5678 kWh in total. */
export const report3 = (over = {}) => ({
  ID: '3',
  U1: 230,
  U2: 231,
  U3: 229,
  I1: 16000,
  I2: 15950,
  I3: 16020,
  P: 11040000,
  PF: 1000,
  'E pres': 52500,
  'E total': 12345678,
  Serial: SERIAL,
  Sec: 1000,
  ...over,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `stations`: host -> { r1, r2, r3, ... }. Per station, the test may set:
 * `silent` (no answer at all), `silentTo` (a list of payloads not answered),
 * `delay` (ms before answering), `refuse` (TCH-ERR to commands), `raw`
 * (payload -> raw text answered), `applies` (false: a command changes
 * nothing), `sendError` (true or a list of payloads: the socket send fails).
 */
export function fakeKeba(stations = { [HOST]: { r1: report1(), r2: report2(), r3: report3() } }) {
  const net = {
    stations,
    /** { host, port, payload, at } */
    sent: [],
    bindError: undefined,
    sockets: [],
    payloads: () => net.sent.map((s) => s.payload),
    commands: () => net.sent.filter((s) => !s.payload.startsWith('report')).map((s) => s.payload),
    createSocket() {
      const socket = new EventEmitter();
      net.sockets.push(socket);
      socket.bind = (port, callback) => {
        setImmediate(() => {
          if (net.bindError) {
            socket.emit('error', Object.assign(new Error('bind'), { code: net.bindError }));
          } else {
            socket.port = port;
            callback();
          }
        });
      };
      socket.close = () => {
        socket.closed = true;
      };
      socket.send = (buffer, port, host, callback) => {
        const payload = buffer.toString('latin1');
        net.sent.push({ host, port, payload, at: Date.now() });
        const station = net.stations[host];
        if (station?.sendError === true || station?.sendError?.includes?.(payload)) {
          setImmediate(() => callback(Object.assign(new Error('send'), { code: 'ENETUNREACH' })));
          return;
        }
        setImmediate(() => callback(null));
        if (!station || station.silent || station.silentTo?.includes(payload)) {
          return;
        }
        const answer = () => {
          const text = net.answer(station, payload);
          if (text !== undefined) {
            setImmediate(() =>
              socket.emit('message', Buffer.from(text, 'latin1'), { address: host, port: 7090 }),
            );
          }
        };
        if (station.delay) {
          wait(station.delay).then(answer);
        } else {
          answer();
        }
      };
      return socket;
    },
    /** The text a station answers to `payload` (and what it changes). */
    answer(station, payload) {
      if (station.raw && payload in station.raw) {
        return station.raw[payload];
      }
      if (payload === 'report 1') return JSON.stringify(station.r1);
      if (payload === 'report 2') return JSON.stringify(station.r2);
      if (payload === 'report 3') return station.r3 ? JSON.stringify(station.r3) : undefined;
      if (station.refuse) return 'TCH-ERR :unknown command';
      if (station.applies !== false) {
        if (payload === 'ena 1' || payload === 'ena 0') {
          station.r2['Enable user'] = payload === 'ena 1' ? 1 : 0;
        } else if (payload.startsWith('curr ')) {
          station.r2['Curr user'] = Number(payload.slice(5));
        }
      }
      return 'TCH-OK :done\n';
    },
    /** A datagram the test injects, as if `host` had sent it. */
    inject(host, text) {
      for (const socket of net.sockets) {
        socket.emit('message', Buffer.from(text, 'latin1'), { address: host, port: 7090 });
      }
    },
  };
  return net;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
