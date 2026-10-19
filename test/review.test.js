// -----------------------------------------------------------------------------
// Non-regression tests of the review of Milestone 1 (scenarios S1, S2, S3,
// S8, S11 of the reviewer, and one test per point I1-I4, M1-M12), several
// stations behind the fake UDP socket, real handlers, mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KebaApp } from '../src/app.js';
import { MINUTE, SECOND, TIMINGS } from '../src/constants.js';
import { hardwareLimit } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { ERRORS, FEATURE_NAMES, T } from '../src/i18n.js';
import { KebaChannel } from '../src/keba/channel.js';
import { NOW, fakeKeba, report1, report2, report3, settle } from './fixtures/fakeKeba.js';

const A = '192.168.1.60';
const B = '192.168.1.61';
const C = '192.168.1.62';
const SA = '11110001';
const SB = '11110002';
const SC = '11110003';
const ALLOWED = (addresses) => ({ addresses, allow_commands: true });

const station = (serial, over2 = {}, extra = {}) => ({
  r1: report1({ Serial: serial }),
  r2: report2({ Serial: serial, ...over2 }),
  r3: report3({ Serial: serial }),
  ...extra,
});

async function setup(t, { config, net }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const now = () => Date.now();
  const channel = new KebaChannel({ createSocket: net.createSocket, now });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l}: ${a.join(' ')}`)]),
  );
  const app = new KebaApp({ gladys, logger, channel, now });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(5);
    }
  };
  let connected = false;
  const connecting = gladys.connect().finally(() => {
    connected = true;
  });
  await settle();
  for (let w = 0; !connected && w < 60 * SECOND; w += 100) await advance(100, 50);
  await connecting;
  await settle();
  t.after(() => app.shutdown());
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
    await settle();
  }
  const fire = (serial, role, value = 1) => {
    const id = `ext:test-integration:keba:${serial}`;
    const device = gladys.fake.devices.find((d) => d.external_id === id);
    const feature = device.features.find((f) => f.external_id === `${id}:${role}`);
    return gladys.fake.setValue(device, feature, value);
  };
  return { gladys, app, net, advance, logs, fire, channel };
}

const UNCONFIRMED = /envoyée, sans confirmation/;
const UNSENT = /non envoyée|pas pu être envoyée/;

test('S1 / I1: a forbid 0.5 s after an allow without answer is sent, the allow is "sent, without confirmation"', async (t) => {
  const net = fakeKeba({ [A]: station(SA, { 'Enable user': 0 }, { silentTo: ['ena 1'] }) });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  net.sent.length = 0;
  const allow = fire(SA, 'enable-charge');
  await advance(500);
  const forbid = fire(SA, 'disable-charge');
  await advance(6 * SECOND);
  const [a, f] = await Promise.all([allow, forbid]);
  assert.equal(a.success, false);
  assert.match(a.error, UNCONFIRMED);
  // Its answer may be the late one of the "allow": no confirmation, but sent.
  assert.doesNotMatch(f.error ?? '', UNSENT);
  const payloads = net.payloads();
  assert.ok(payloads.includes('ena 0'), 'ena 0 sent');
  assert.ok(payloads.indexOf('ena 0') > payloads.indexOf('ena 1'), 'after the allow');
});

test('S2 / I1: "forbid" on three stations at once: all three sent, the 2 s pause is per station', async (t) => {
  const net = fakeKeba({ [A]: station(SA), [B]: station(SB), [C]: station(SC) });
  const { fire, advance } = await setup(t, { config: ALLOWED(`${A},${B},${C}`), net });
  await advance(2 * SECOND);
  net.sent.length = 0;
  const acks = [fire(SA, 'disable-charge'), fire(SB, 'disable-charge'), fire(SC, 'disable-charge')];
  await advance(7 * SECOND);
  const res = await Promise.all(acks);
  for (const r of res) assert.equal(r.success, true, r.error);
  const sent = net.sent.filter((s) => s.payload === 'ena 0');
  assert.deepEqual(sent.map((s) => s.host).sort(), [A, B, C]);
  assert.ok(sent.at(-1).at - sent[0].at < TIMINGS.gapAfterDisable, 'not 2 s apart');
});

test('S3 / I2: the option turned off while the command waits in the channel: never sent', async (t) => {
  const net = fakeKeba({ [A]: station(SA), [B]: station(SB), [C]: station(SC) });
  const { gladys, fire, advance } = await setup(t, { config: ALLOWED(`${A},${B},${C}`), net });
  await advance(2 * SECOND);
  net.stations[B].silentTo = ['report 2'];
  net.stations[C].silentTo = ['report 2'];
  net.sent.length = 0;
  const stopB = fire(SB, 'disable-charge');
  await advance(20);
  const cur = fire(SA, 'set-current', '10');
  await advance(20);
  const stopC = fire(SC, 'disable-charge');
  await advance(1900);
  await gladys.fake.configUpdated({ addresses: `${A},${B},${C}`, allow_commands: false });
  const offAt = Date.now();
  await advance(6 * SECOND);
  const [c] = await Promise.all([cur, stopB, stopC]);
  assert.equal(c.success, false);
  assert.ok(
    !net.sent.some((x) => x.at >= offAt && !x.payload.startsWith('report')),
    'no command left after the option was turned off',
  );
});

test('S8 / I3: a scene changing the current every 5 s: at most one curr a minute', async (t) => {
  const net = fakeKeba({ [A]: station(SA) });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  net.sent.length = 0;
  const errors = [];
  for (let i = 0; i < 24; i += 1) {
    const p = fire(SA, 'set-current', i % 2 ? '10' : '11');
    await advance(5 * SECOND, 50);
    const ack = await p;
    if (!ack.success) errors.push(ack.error);
  }
  const n = net.commands().filter((c) => c.startsWith('curr')).length;
  assert.ok(n >= 2 && n <= 3, `${n} curr in 2 min`);
  assert.ok(errors.every((e) => /une fois par minute/.test(e) && /Interdire la charge/.test(e)));
  // "Forbid" is never limited.
  const f = fire(SA, 'disable-charge');
  await advance(5 * SECOND);
  assert.equal((await f).success, true);
});

test('S11 / I4: TCH-OK without effect: one warning, said in the status', async (t) => {
  const net = fakeKeba({ [A]: station(SA, { 'Enable user': 0 }, { applies: false }) });
  const { fire, advance, logs, gladys } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  const p = fire(SA, 'enable-charge');
  await advance(5 * SECOND);
  assert.equal((await p).success, true, 'accepted');
  await advance(100 * SECOND, 500);
  const warnings = logs.filter((l) => l.startsWith('warn') && /not applied/.test(l));
  assert.equal(warnings.length, 1);
  assert.match(gladys.fake.connectionStatus.message.fr, /a accepté .* sans l'appliquer/);
  assert.match(gladys.fake.connectionStatus.message.fr, /c-series \?/);
  // A second "allow" not applied either: still one warning.
  const again = fire(SA, 'enable-charge');
  await advance(100 * SECOND, 500);
  await again;
  assert.equal(logs.filter((l) => l.startsWith('warn') && /not applied/.test(l)).length, 1);
});

test('I4: an accepted command applied: no warning', async (t) => {
  const net = fakeKeba({ [A]: station(SA, { 'Enable user': 0 }) });
  const { fire, advance, logs, gladys } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  const p = fire(SA, 'enable-charge');
  await advance(100 * SECOND, 500);
  assert.equal((await p).success, true);
  assert.ok(!logs.some((l) => /not applied/.test(l)));
  assert.doesNotMatch(gladys.fake.connectionStatus.message.fr, /sans l'appliquer/);
});

test('I1: a forbid releases the wait of a current in flight at once', async (t) => {
  const net = fakeKeba({ [A]: station(SA, {}, { delays: { 'curr 10000': 3000 } }) });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  net.sent.length = 0;
  let curDone;
  const cur = fire(SA, 'set-current', '10').then((r) => {
    curDone = Date.now();
    return r;
  });
  await advance(400);
  assert.ok(net.payloads().includes('curr 10000'));
  const forbidAt = Date.now();
  const forbid = fire(SA, 'disable-charge');
  await advance(6 * SECOND);
  const [c, f] = await Promise.all([cur, forbid]);
  assert.match(c.error, UNCONFIRMED);
  assert.ok(curDone - forbidAt < 100, 'released at once');
  assert.ok(net.payloads().includes('ena 0'));
  assert.doesNotMatch(f.error ?? '', UNSENT);
});

test('I1 / M7: the channel busy until the deadline: "busy", distinct from "too slow"', async (t) => {
  const net = fakeKeba({ [A]: station(SA) });
  const { fire, advance, channel } = await setup(t, { config: ALLOWED(A), net });
  const { ChannelError, ERROR_KINDS } = await import('../src/keba/channel.js');
  channel.request = async () => {
    throw new ChannelError(ERROR_KINDS.LATE, 'too late to send');
  };
  const p = fire(SA, 'set-current', '10');
  await advance(SECOND);
  const r = await p;
  assert.equal(r.error, ERRORS.channelBusy.fr);
  assert.notEqual(ERRORS.channelBusy.fr, ERRORS.tooSlow.fr);
  assert.match(ERRORS.channelBusy.fr, /occupée/);
});

test('M1: a late TCH-OK of a timed-out allow never confirms the next forbid', async (t) => {
  const net = fakeKeba({
    [A]: station(SA, { 'Enable user': 0 }, { delays: { 'ena 1': 4600 }, silentTo: ['ena 0'] }),
  });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  const allow = fire(SA, 'enable-charge');
  await advance(4000);
  const forbid = fire(SA, 'disable-charge');
  await advance(6 * SECOND);
  const [, f] = await Promise.all([allow, forbid]);
  assert.equal(f.success, false, 'never reported done');
  assert.match(f.error, UNCONFIRMED);
});

test('M2: a late report 2 of a timed-out poll never decides an allow', async (t) => {
  const net = fakeKeba({ [A]: station(SA, { 'Enable user': 1 }) });
  const { fire, advance, net: n } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  // The next poll's report 2 is answered 2.15 s late, with "enabled".
  n.stations[A].delays = { 'report 2': 2150 };
  const before = n.sent.length;
  let polled;
  for (let i = 0; i < 400 && !polled; i += 1) {
    await advance(100, 10);
    polled = n.sent.slice(before).find((s) => s.payload === 'report 2');
  }
  n.stations[A].r2 = { ...n.stations[A].r2, 'Enable user': 0 };
  n.stations[A].delays = { 'report 2': 250 };
  await advance(1950 - (Date.now() - polled.at), 10);
  const p = fire(SA, 'enable-charge');
  await advance(5 * SECOND);
  const r = await p;
  // Never "already allowed" on the late answer: refused unsent, or sent.
  assert.equal(r.success, false);
  assert.match(r.error, /en retard/);
  assert.deepEqual(n.commands(), []);
});

test('M3: shutdown while a command waits for its answer: "sent, without confirmation"', async (t) => {
  const net = fakeKeba({ [A]: station(SA, {}, { delays: { 'ena 0': 3000 } }) });
  const { app, fire, advance, net: n } = await setup(t, { config: ALLOWED(A), net });
  await advance(2 * SECOND);
  const f = fire(SA, 'disable-charge');
  await advance(300);
  assert.ok(n.payloads().includes('ena 0'));
  app.shutdown();
  await advance(200);
  assert.match((await f).error, UNCONFIRMED);
});

test('M4: a report 2 without serial: read only, commands refused', async (t) => {
  const s = station(SA);
  delete s.r2.Serial;
  delete s.r3.Serial;
  const net = fakeKeba({ [A]: s });
  const { gladys, fire, advance } = await setup(t, { config: ALLOWED(A), net });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.lastState(`ext:test-integration:keba:${SA}:power`), 11040);
  const p = fire(SA, 'disable-charge');
  await advance(5 * SECOND);
  assert.match((await p).error, /numéro de série/);
  assert.deepEqual(net.commands(), []);
});

test('M5: Curr HW 20.5 A allows 20 A, never 21 A', async (t) => {
  assert.equal(hardwareLimit(20.5), 20);
  assert.equal(hardwareLimit(5.9), undefined);
  const net = fakeKeba({ [A]: station(SA, { 'Curr HW': 20500 }) });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  let p = fire(SA, 'set-current', '21');
  await advance(5 * SECOND);
  assert.match((await p).error, /entre 6 et 20 A/);
  p = fire(SA, 'set-current', '20');
  await advance(5 * SECOND);
  assert.equal((await p).success, true);
  assert.deepEqual(net.commands(), ['curr 20000']);
});

test('M6: "forbid" goes even when report 2 lacks "Enable user"', async (t) => {
  const s = station(SA);
  delete s.r2['Enable user'];
  const net = fakeKeba({ [A]: s });
  const { fire, advance } = await setup(t, { config: ALLOWED(A), net });
  const p = fire(SA, 'disable-charge');
  await advance(5 * SECOND);
  assert.equal((await p).success, true);
  assert.deepEqual(net.commands(), ['ena 0']);
});

test('M7: the French texts use no English word', () => {
  const texts = [
    ...Object.values(FEATURE_NAMES).map((x) => x.fr),
    ...Object.values(ERRORS)
      .map((x) => (typeof x === 'function' ? x('x', 'y') : x))
      .map((x) => x.fr),
    T.unreachable('x', { fr: '1 s' }).fr,
    T.notApplied('x', 'ena').fr,
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /failsafe|switch|load management|charging/i, text);
  }
});

test('M10: broadcast, multicast, loopback addresses refused', async () => {
  const { parseAddress } = await import('../src/config.js');
  for (const bad of ['255.255.255.255', '192.168.1.255', '224.0.0.1', '127.0.0.1', '0.0.0.0']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(parseAddress('10.0.0.1'), '10.0.0.1');
});

test('M11: the device publications never overlap', async (t) => {
  const net = fakeKeba({ [A]: station(SA) });
  const { app, gladys } = await setup(t, { config: { addresses: A }, net });
  let running = 0;
  let max = 0;
  gladys.publishDiscoveredDevices = async () => {
    running += 1;
    max = Math.max(max, running);
    await settle(3);
    running -= 1;
  };
  app.published = undefined;
  const first = app.publishDevices();
  app.published = undefined;
  const second = app.publishDevices();
  await settle(20);
  await Promise.all([first, second]);
  assert.equal(max, 1);
});

test('M12: the read after a command never joins a read begun before it', async (t) => {
  const net = fakeKeba({ [A]: station(SA) });
  const { app, advance, net: n } = await setup(t, { config: { addresses: A }, net });
  const s = [...app.stations.values()][0];
  n.stations[A].delay = 500;
  const before = app.tick(s);
  const sent = n.sent.length;
  const after = app.freshTick(s);
  assert.notEqual(after, before);
  await advance(3 * SECOND, 50);
  await after;
  assert.ok(n.sent.length - sent >= 4, 'a second read ran');
  void MINUTE;
});
