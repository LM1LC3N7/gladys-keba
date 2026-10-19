// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and fake stations behind a fake UDP socket. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KebaApp } from '../src/app.js';
import { ACTIONS, MINUTE, SECOND, TIMINGS } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { KebaChannel } from '../src/keba/channel.js';
import {
  HOST,
  NOW,
  SERIAL,
  fakeKeba,
  report1,
  report2,
  report3,
  settle,
} from './fixtures/fakeKeba.js';

const CONFIG = { addresses: HOST };
const ALLOWED = { addresses: HOST, allow_commands: true };
const DEVICE = `ext:test-integration:keba:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(t, { config = CONFIG, net = fakeKeba(), create = true, logs = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const now = () => Date.now();
  const channel = new KebaChannel({ createSocket: net.createSocket, now });
  const app = new KebaApp({ gladys, logger: recorder(logs), channel, now });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 50) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  // connect() resolves once the start ran: the first read (three reports,
  // 100 ms apart) needs the clock to move.
  let connected = false;
  const connecting = gladys.connect().finally(() => {
    connected = true;
  });
  await settle();
  for (let waited = 0; !connected && waited < 10 * SECOND; waited += 100) {
    await advance(100);
  }
  await connecting;
  await settle();
  t.after(() => app.shutdown());
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices.at(-1));
    await settle();
  }
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    const target = device.features.find((f) => f.external_id === feature(role));
    const ack = gladys.fake.setValue(device, target, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, net, advance, logs, press, station: net.stations[HOST] };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);

test('without an address, the status asks for it and nothing is sent', async (t) => {
  const net = fakeKeba();
  const { gladys } = await setup(t, { config: {}, net });
  assert.equal(net.sent.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(net.sent.length, 0);
});

test('a host name is refused: an IPv4 address is expected', async (t) => {
  const net = fakeKeba();
  const { gladys } = await setup(t, { config: { addresses: 'keba.local' }, net });
  assert.equal(net.sent.length, 0);
  assert.match(message(gladys).en, /IPv4 address is expected\): keba\.local/);
});

test('one read: reports 1, 2, 3 to port 7090, 100 ms apart; the device; its states', async (t) => {
  const { gladys, net } = await setup(t);
  assert.deepEqual(
    net.sent.map((s) => `${s.host}:${s.port} ${s.payload}`),
    [`${HOST}:7090 report 1`, `${HOST}:7090 report 2`, `${HOST}:7090 report 3`],
  );
  for (let i = 1; i < net.sent.length; i += 1) {
    assert.ok(net.sent[i].at - net.sent[i - 1].at >= TIMINGS.gap, `gap before ${i}`);
  }
  assert.equal(net.sockets[0].port, 7090);
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'KEBA P30 1234');
  assert.equal(device.model, 'KEBA P30');
  assert.deepEqual(device.params, [
    { name: 'serial_number', value: SERIAL },
    { name: 'product', value: 'KC-P30-EC240422-E00' },
    { name: 'firmware', value: 'P30 v 3.10.16 (211025-071420)' },
  ]);
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
      f.read_only,
    ]),
    [
      ['status', 'text', 'text', undefined, true],
      ['connector-status', 'charging-station', 'connector-status', undefined, true],
      ['charging-state', 'charging-station', 'charging-state', undefined, true],
      ['vehicle-plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
      ['cable-station', 'unknown', 'binary', undefined, true],
      ['cable-locked', 'unknown', 'binary', undefined, true],
      ['power', 'energy-sensor', 'power', 'watt', true],
      ['current-l1', 'energy-sensor', 'current', 'ampere', true],
      ['current-l2', 'energy-sensor', 'current', 'ampere', true],
      ['current-l3', 'energy-sensor', 'current', 'ampere', true],
      ['voltage-l1', 'energy-sensor', 'voltage', 'volt', true],
      ['voltage-l2', 'energy-sensor', 'voltage', 'volt', true],
      ['voltage-l3', 'energy-sensor', 'voltage', 'volt', true],
      [
        'session-energy',
        'electrical-vehicle-charge',
        'last-charge-energy-added',
        'kilowatt-hour',
        true,
      ],
      [
        'total-energy',
        'electrical-vehicle-charge',
        'charge-energy-consumption-total',
        'kilowatt-hour',
        true,
      ],
      ['max-current', 'electrical-vehicle-charge', 'target-current', 'ampere', true],
      ['enabled-system', 'unknown', 'binary', undefined, true],
      ['enabled-user', 'unknown', 'binary', undefined, true],
      ['failsafe', 'unknown', 'binary', undefined, true],
      ['auth-required', 'unknown', 'binary', undefined, true],
      ['enable-charge', 'button', 'push', undefined, false],
      ['disable-charge', 'button', 'push', undefined, false],
      ['set-current', 'text', 'select', undefined, false],
    ],
  );
  const select = device.features.at(-1);
  assert.equal(select.supported_options[0].value, '6');
  assert.equal(select.supported_options.at(-1).value, '32');

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'vehicle-plugged'), 1);
  assert.equal(last(gladys, 'cable-station'), 1);
  assert.equal(last(gladys, 'cable-locked'), 1);
  assert.equal(last(gladys, 'power'), 11040);
  assert.equal(last(gladys, 'current-l1'), 16);
  assert.equal(last(gladys, 'current-l2'), 15.95);
  assert.equal(last(gladys, 'voltage-l3'), 229);
  assert.equal(last(gladys, 'session-energy'), 5.25);
  assert.equal(last(gladys, 'total-energy'), 1234.568);
  assert.equal(last(gladys, 'max-current'), 16);
  assert.equal(last(gladys, 'enabled-system'), 1);
  assert.equal(last(gladys, 'enabled-user'), 1);
  assert.equal(last(gladys, 'failsafe'), 0);
  assert.equal(last(gladys, 'auth-required'), 0);
  assert.equal(last(gladys, 'set-current'), '16');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /KEBA P30 1234 : En charge, 11040 W, maximum 16 A/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
});

test('the energies are plain sensors: never an index, never a consumption', async (t) => {
  const { gladys, advance } = await setup(t);
  await advance(2 * MINUTE, SECOND);
  for (const f of deviceOf(gladys).features) {
    assert.ok(
      !(f.category === 'energy-sensor' && ['energy', 'index'].includes(f.type)),
      `${f.external_id} is an energy index`,
    );
  }
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, []);
});

test('the polling: report 2 and 3 every interval, report 1 every hour', async (t) => {
  const { net, advance } = await setup(t);
  net.sent.length = 0;
  await advance(31 * SECOND, 100);
  assert.deepEqual(net.payloads(), ['report 2', 'report 3']);
  net.sent.length = 0;
  await advance(60 * MINUTE, 10 * SECOND);
  assert.equal(net.payloads().filter((p) => p === 'report 1').length, 1);
});

test('states: unplugged, plugged waiting, not ready, error, failsafe on', async (t) => {
  const { gladys, advance, station } = await setup(t);
  station.r2 = report2({ State: 1, Plug: 0 });
  await advance(31 * SECOND, 100);
  assert.equal(last(gladys, 'status'), 'Pas prête pour la charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.AVAILABLE);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.IDLE);
  assert.equal(last(gladys, 'vehicle-plugged'), 0);
  assert.equal(last(gladys, 'cable-station'), 0);
  station.r2 = report2({ State: 2, Plug: 5 });
  await advance(31 * SECOND, 100);
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.EV_CONNECTED);
  assert.equal(last(gladys, 'cable-locked'), 0);
  station.r2 = report2({ State: 1, Plug: 7, 'Enable user': 0 });
  await advance(31 * SECOND, 100);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.PAUSED_BY_CHARGER);
  assert.equal(last(gladys, 'enabled-user'), 0);
  station.r2 = report2({ State: 4 });
  await advance(31 * SECOND, 100);
  assert.equal(last(gladys, 'status'), 'Erreur');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.FAULTED);
  station.r2 = report2({ 'Tmo FS': 60, 'Curr FS': 6000 });
  await advance(31 * SECOND, 100);
  assert.equal(last(gladys, 'failsafe'), 1);
});

test('a P20 e-series has no meter: no report 3, its meter features stay empty', async (t) => {
  const net = fakeKeba({
    [HOST]: { r1: report1({ Product: 'KC-P20-ES230001-000' }), r2: report2() },
  });
  const { gladys } = await setup(t, { net });
  assert.deepEqual(net.payloads(), ['report 1', 'report 2']);
  assert.equal(deviceOf(gladys).features.length, 23, 'every feature, always');
  assert.equal(last(gladys, 'power'), undefined);
  assert.equal(last(gladys, 'status'), 'En charge');
});

test('report 3 failing never holds back the state', async (t) => {
  const net = fakeKeba({
    [HOST]: { r1: report1(), r2: report2(), r3: report3(), silentTo: ['report 3'] },
  });
  const { gladys, logs } = await setup(t, { net });
  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(logs.some((l) => /report 3 unavailable/.test(l)));
});

test('a total energy of 0 is never published', async (t) => {
  const net = fakeKeba({
    [HOST]: { r1: report1(), r2: report2(), r3: report3({ 'E total': 0 }) },
  });
  const { gladys } = await setup(t, { net });
  assert.equal(last(gladys, 'total-energy'), undefined);
  assert.equal(last(gladys, 'session-energy'), 5.25);
});

test('a station not answering: unreachable, then spaced retries', async (t) => {
  const { gladys, advance, station, net } = await setup(t);
  station.silent = true;
  await advance(35 * SECOND, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Pas de réponse de 192\.168\.1\.60/);
  assert.match(message(gladys).fr, /DIP switch/);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(last(gladys, 'power'), 11040, 'the other values are kept');
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  net.sent.length = 0;
  await advance(31 * SECOND, 100);
  assert.equal(net.sent.length, 1, 'next try after 30 s');
  station.silent = false;
  await advance(2 * MINUTE, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'status'), 'En charge');
});

test('another station at the address: identified again, its own device', async (t) => {
  const { gladys, advance, station } = await setup(t);
  station.r1 = report1({ Serial: '99887766' });
  station.r2 = report2({ Serial: '99887766' });
  station.r3 = report3({ Serial: '99887766' });
  await advance(31 * SECOND, 100);
  assert.equal(deviceOf(gladys).external_id, 'ext:test-integration:keba:99887766');
  // The created device of the first one is not read any more.
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, new RegExp(`Not read any more: .*${SERIAL}`));
});

test('a report 1 without serial: no device, the status says so', async (t) => {
  const net = fakeKeba({ [HOST]: { r1: report1({ Serial: '' }), r2: report2() } });
  const { gladys } = await setup(t, { net });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(message(gladys).en, /without a valid serial number/);
});

test('UDP port 7090 taken: the status says so, bound again a minute later', async (t) => {
  const net = fakeKeba();
  net.bindError = 'EADDRINUSE';
  const { gladys, advance } = await setup(t, { net });
  assert.equal(net.sent.length, 0);
  assert.match(message(gladys).fr, /port UDP 7090/);
  net.bindError = undefined;
  await advance(MINUTE + 2 * SECOND, SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(deviceOf(gladys).external_id, DEVICE);
});

test('a reconnection to Gladys resends status, device, states and badge', async (t) => {
  const { gladys, net } = await setup(t);
  const devices = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const sent = net.sent.length;
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, devices + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(net.sent.length, sent, 'no new read, no restart');
});

test('the test button reads now, at most every 10 s', async (t) => {
  const { gladys, net, advance } = await setup(t);
  const sent = net.sent.length;
  const pending = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(SECOND);
  let ack = await pending;
  assert.match(ack.data.message.fr, /KEBA P30 1234 : En charge/);
  assert.equal(net.sent.length, sent + 2);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /less than 10 s/);
  assert.equal(net.sent.length, sent + 2);
});

// --- Commands ------------------------------------------------------------------

test('commands are refused while the option is off: nothing sent', async (t) => {
  const { press, net } = await setup(t);
  for (const [role, value] of [
    ['enable-charge', 1],
    ['disable-charge', 1],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value, SECOND);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /Autoriser les commandes/);
  }
  assert.deepEqual(net.commands(), []);
});

test('read-only features refuse a command', async (t) => {
  const { press, net } = await setup(t, { config: ALLOWED });
  for (const role of ['enabled-user', 'failsafe', 'max-current', 'status']) {
    const ack = await press(role, 1, SECOND);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /lecture seule/);
  }
  assert.deepEqual(net.commands(), []);
});

test('forbid then allow charging: a fresh report 2, then ena 0 / ena 1', async (t) => {
  const { gladys, press, net, station } = await setup(t, { config: ALLOWED });
  net.sent.length = 0;
  let ack = await press('disable-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.payloads().slice(0, 2), ['report 2', 'ena 0']);
  assert.equal(station.r2['Enable user'], 0);
  // keba-kecontact waits 2 s after "ena 0" before the next message.
  const disableAt = net.sent.find((s) => s.payload === 'ena 0').at;
  const next = net.sent.find((s) => s.at > disableAt);
  assert.ok(next.at - disableAt >= TIMINGS.gapAfterDisable, 'pause after ena 0');
  assert.equal(last(gladys, 'enabled-user'), 0);
  net.sent.length = 0;
  ack = await press('enable-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.payloads().slice(0, 2), ['report 2', 'ena 1']);
  assert.equal(station.r2['Enable user'], 1);
});

test('already so: nothing sent', async (t) => {
  const { press, net } = await setup(t, { config: ALLOWED });
  const ack = await press('enable-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.commands(), []);
});

test('the charging current: 6 A to the hardware limit, checked on the fresh report', async (t) => {
  const { press, net, station } = await setup(t, { config: ALLOWED });
  let ack = await press('set-current', '20');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.commands(), ['curr 20000']);
  assert.equal(station.r2['Curr user'], 20000);
  // Above the hardware limit read just before (now 16 A): refused, not sent.
  station.r2['Curr HW'] = 16000;
  ack = await press('set-current', '20');
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 16 A/);
  // No hardware limit (cable unplugged): refused.
  station.r2['Curr HW'] = 0;
  ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /limite matérielle/);
  assert.deepEqual(net.commands(), ['curr 20000']);
});

test('a command value is validated strictly', async (t) => {
  const { press, net } = await setup(t, { config: ALLOWED });
  for (const value of [null, '', ' ', true, 12.5, '1e1', '0', 5, 64, '100', 'abc']) {
    const ack = await press('set-current', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  for (const value of [0, 2, '', null, true]) {
    const ack = await press('enable-charge', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  assert.deepEqual(net.commands(), []);
});

test('TCH-ERR: refused by the station, said as such', async (t) => {
  const { press, station } = await setup(t, { config: ALLOWED });
  station.refuse = true;
  const ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /a refusé la commande \(TCH-ERR\)/);
});

test('no answer to the command: "sent, without confirmation", and the guard', async (t) => {
  const { press, net, station } = await setup(t, { config: ALLOWED });
  station.silentTo = ['ena 0'];
  station.applies = false;
  let ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  // The station still shows "enabled", but the "forbid" may land: an "allow"
  // is sent anyway, never answered "already so".
  station.silentTo = [];
  station.applies = true;
  ack = await press('enable-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(net.commands(), ['ena 0', 'ena 1']);
});

test('the send of the command fails: "not sent"', async (t) => {
  const { press, station } = await setup(t, { config: ALLOWED });
  station.sendError = ['ena 0'];
  const ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être envoyée \(send\)/);
});

test('the fresh report does not answer: refused, not sent', async (t) => {
  const { press, net, station } = await setup(t, { config: ALLOWED });
  station.silent = true;
  const ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être relu juste avant/);
  assert.deepEqual(net.commands(), []);
});

test('the option turned off during the fresh read: not sent', async (t) => {
  const { gladys, net, station, advance } = await setup(t, { config: ALLOWED });
  station.delay = 500;
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = device.features.find((f) => f.external_id === feature('disable-charge'));
  const ack = gladys.fake.setValue(device, target, 1);
  await settle();
  await gladys.fake.configUpdated({ addresses: HOST, allow_commands: false });
  await advance(5 * SECOND);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /Autoriser les commandes/);
  assert.deepEqual(net.commands(), []);
});

test('another station answers the fresh report: refused, not sent', async (t) => {
  const { press, net, station } = await setup(t, { config: ALLOWED });
  station.r2 = report2({ Serial: '99887766' });
  const ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Une autre borne/);
  assert.deepEqual(net.commands(), []);
});

test('a product the integration does not know: commands refused', async (t) => {
  const net = fakeKeba({
    [HOST]: { r1: report1({ Product: 'XX-P99-AB123456-000' }), r2: report2(), r3: report3() },
  });
  const { press } = await setup(t, { config: ALLOWED, net });
  const ack = await press('disable-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /XX-P99-AB123456-000/);
  assert.deepEqual(net.commands(), []);
});

test('one command at a time per station; "forbid" is never refused for one in flight', async (t) => {
  const { gladys, net, station, advance } = await setup(t, { config: ALLOWED });
  station.delay = 300;
  station.r2['Enable user'] = 0;
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const f = (role) => device.features.find((x) => x.external_id === feature(role));
  const first = gladys.fake.setValue(device, f('enable-charge'), 1);
  await settle();
  const second = gladys.fake.setValue(device, f('set-current'), '10');
  const stop = gladys.fake.setValue(device, f('disable-charge'), 1);
  await advance(5 * SECOND);
  const [a, b, c] = await Promise.all([first, second, stop]);
  assert.equal(b.success, false);
  assert.match(b.error, /encore en cours/);
  // The "allow" reaches its send point after the "forbid" arrived: not sent.
  assert.equal(a.success, false);
  assert.match(a.error, /interdiction de charge/);
  // Already forbidden: the "forbid" sends nothing.
  assert.equal(c.success, true, c.error);
  assert.deepEqual(net.commands(), []);
});

test('the failsafe mode is never written', async (t) => {
  const { press, net, advance } = await setup(t, { config: ALLOWED });
  await press('disable-charge');
  await press('enable-charge');
  await press('set-current', '10');
  await advance(MINUTE, SECOND);
  assert.ok(net.payloads().every((p) => !/failsafe|currtime|start|stop|unlock|x2/.test(p)));
});
