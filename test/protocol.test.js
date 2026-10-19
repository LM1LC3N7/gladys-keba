// -----------------------------------------------------------------------------
// The protocol, pure: answer kinds, products (keba-kecontact's own test
// products), units, and hostile answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER,
  COMMANDS,
  classify,
  identityOf,
  meterOf,
  plugFlags,
  stateOf,
} from '../src/keba/protocol.js';
import { report1, report2, report3 } from './fixtures/fakeKeba.js';

test('answer kinds', () => {
  assert.equal(classify('TCH-OK :done\n').kind, ANSWER.TCH_OK);
  assert.equal(classify('TCH-ERR').kind, ANSWER.TCH_ERR);
  assert.equal(classify('i').kind, ANSWER.BROADCAST);
  assert.equal(classify('"Firmware":"P30 v 3.10"\n').kind, ANSWER.BROADCAST);
  assert.equal(classify('{"State": 3}').kind, ANSWER.PUSH);
  assert.deepEqual(
    [classify(JSON.stringify(report2())).kind, classify(JSON.stringify(report2())).id],
    [ANSWER.REPORT, 2],
  );
  assert.equal(classify('{"ID": "101"}').id, 101);
  for (const text of ['', 'garbage', '[1,2]', 'null', '{"ID": "x"}', '{"ID": {}}', undefined]) {
    assert.equal(classify(text).kind, ANSWER.UNKNOWN, String(text));
  }
});

const identity = (Product) => identityOf(report1({ Product }));

test('products, as keba-kecontact reads them', () => {
  assert.deepEqual(
    ['KC-P20-ES230001-000', 'KC-P20-EC230101-000'].map((p) => identity(p).meter),
    [false, false],
    'P20 e-series',
  );
  for (const p of ['KC-P20-ES240010-000', 'KC-P20-ES240020-000', 'KC-P20-EC220130-000']) {
    assert.equal(identity(p).meter, true, p);
    assert.equal(identity(p).recognized, true, p);
  }
  const p30 = identity('KC-P30-EC240422-E00');
  assert.deepEqual(
    [p30.manufacturer, p30.model, p30.meter, p30.recognized],
    ['KEBA', 'P30', true, true],
  );
  const de = identity('KC-P30-EC220112-000-DE');
  assert.deepEqual([de.model, de.meter, de.recognized], ['P30-DE', false, true]);
  const bmw = identity('BMW-10-EC240522-E1R');
  assert.deepEqual(
    [bmw.manufacturer, bmw.model, bmw.meter, bmw.recognized],
    ['BMW', 'Wallbox Plus', true, true],
  );
  assert.equal(identity('BMW-10-EC2405B2-E1R').model, 'Wallbox Connect');
  assert.equal(identity('XX-P99-AB123456-000').recognized, false);
  assert.equal(identity('BMW-10').recognized, false, 'too short');
});

test('report 1 without serial or product, or not report 1: no identity', () => {
  assert.equal(identityOf(report1({ Serial: '' })), undefined);
  assert.equal(identityOf(report1({ Serial: '12/34' })), undefined);
  assert.equal(identityOf(report1({ Product: 42 })).product, '42');
  assert.equal(identityOf(report1({ Product: undefined })), undefined);
  assert.equal(identityOf(report1({ ID: '2' })), undefined);
  assert.equal(identityOf(null), undefined);
  assert.equal(identityOf([]), undefined);
});

test('report 2: units and flags', () => {
  const s = stateOf(report2());
  assert.deepEqual(s, {
    serial: '22501234',
    state: 3,
    plug: 7,
    enableSys: 1,
    enableUser: 1,
    maxCurrent: 16,
    hardwareCurrent: 32,
    userCurrent: 16,
    failsafeTimeout: 0,
    failsafeCurrent: 0,
    authRequired: 0,
  });
  assert.equal(stateOf(report2({ 'Curr HW': 0 })).hardwareCurrent, undefined);
  assert.equal(stateOf(report2({ State: 9 })).state, undefined);
  assert.equal(stateOf(report2({ Plug: '7' })).plug, 7);
  assert.equal(stateOf(report2({ 'Enable user': 2 })).enableUser, undefined);
  assert.equal(stateOf(report2({ 'Enable user': true })).enableUser, undefined);
  assert.equal(stateOf(report2({ 'Max curr': -1 })).maxCurrent, undefined);
  assert.equal(stateOf(report3()), undefined);
});

test('report 3: V, A, W, kWh', () => {
  const m = meterOf(report3());
  assert.deepEqual(m.voltages, [230, 231, 229]);
  assert.deepEqual(m.currents, [16, 15.95, 16.02]);
  assert.equal(m.power, 11040);
  assert.equal(m.sessionEnergy, 5.25);
  assert.equal(m.totalEnergy, 1234.5678);
  assert.equal(meterOf(report3({ P: 'x', 'E total': -5 })).power, undefined);
  assert.equal(meterOf(report3({ 'E total': -5 })).totalEnergy, undefined);
});

test('hostile answers: prototype keys, wrong types', () => {
  const hostile = JSON.parse(
    '{"ID":"2","__proto__":{"State":3,"Plug":7},"constructor":{"x":1},"Serial":"1"}',
  );
  const s = stateOf(hostile);
  assert.equal(s.state, undefined);
  assert.equal(s.plug, undefined);
  assert.equal(stateOf(report2({ Serial: { toString: 1 } })).serial, undefined);
});

test('plug flags', () => {
  assert.deepEqual(plugFlags(0), { station: 0, locked: 0, vehicle: 0 });
  assert.deepEqual(plugFlags(1), { station: 1, locked: 0, vehicle: 0 });
  assert.deepEqual(plugFlags(3), { station: 1, locked: 1, vehicle: 0 });
  assert.deepEqual(plugFlags(5), { station: 1, locked: 0, vehicle: 1 });
  assert.deepEqual(plugFlags(7), { station: 1, locked: 1, vehicle: 1 });
  assert.deepEqual(plugFlags(undefined), {});
});

test('command texts: never curr 0, never out of 6-63 A', () => {
  assert.equal(COMMANDS.enable(), 'ena 1');
  assert.equal(COMMANDS.disable(), 'ena 0');
  assert.equal(COMMANDS.current(6), 'curr 6000');
  assert.equal(COMMANDS.current(63), 'curr 63000');
  for (const bad of [0, 5, 64, 10.5, '10', NaN]) {
    assert.throws(() => COMMANDS.current(bad), RangeError, String(bad));
  }
});
