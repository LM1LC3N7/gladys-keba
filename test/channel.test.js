// -----------------------------------------------------------------------------
// The UDP channel: one request at a time, the pause between two messages,
// each answer attributed to its request (source address, kind), deadlines.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { ERROR_KINDS, KebaChannel } from '../src/keba/channel.js';
import { HOST, NOW, fakeKeba, report1, report2, settle } from './fixtures/fakeKeba.js';

async function setup(t, net = fakeKeba()) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const channel = new KebaChannel({ createSocket: net.createSocket, now: () => Date.now() });
  const opening = channel.open();
  await settle();
  await opening;
  t.after(() => channel.close());
  const advance = async (ms, step = 10) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle(5);
    }
  };
  return { channel, net, advance };
}

const REPORT2 = { expect: { kind: 'report', id: 2 }, timeoutMs: 2000 };

test('one request at a time, 100 ms apart, in order', async (t) => {
  const { channel, net, advance } = await setup(t);
  const results = Promise.all([
    channel.request(HOST, 'report 1', { expect: { kind: 'report', id: 1 }, timeoutMs: 2000 }),
    channel.request(HOST, 'report 2', REPORT2),
  ]);
  await advance(500);
  const [a, b] = await results;
  assert.equal(a.report.ID, '1');
  assert.equal(b.report.ID, '2');
  assert.deepEqual(net.payloads(), ['report 1', 'report 2']);
  assert.ok(net.sent[1].at - net.sent[0].at >= TIMINGS.gap);
});

test('an answer from another address, of another kind, or too big is dropped', async (t) => {
  const net = fakeKeba({ [HOST]: { r1: report1(), r2: report2(), delay: 200 } });
  const { channel, advance } = await setup(t, net);
  const pending = channel.request(HOST, 'report 2', REPORT2);
  await advance(20);
  net.inject('192.168.1.99', JSON.stringify(report2({ Serial: '1' })));
  net.inject(HOST, JSON.stringify(report1()));
  net.inject(HOST, JSON.stringify({ State: 2 }));
  net.inject(HOST, 'TCH-OK :done');
  net.inject(HOST, JSON.stringify(report2({ Serial: '2', pad: 'x'.repeat(5000) })));
  await advance(300);
  const answer = await pending;
  assert.equal(answer.report.Serial, report2().Serial);
  assert.equal(channel.dropped, 5);
});

test('a late answer of a request that timed out never answers the next one', async (t) => {
  const net = fakeKeba({ [HOST]: { r1: report1(), r2: report2(), delay: 2500 } });
  const { channel, advance } = await setup(t, net);
  const first = channel.request(HOST, 'report 2', REPORT2).catch((err) => err);
  await advance(2100);
  assert.equal((await first).kind, ERROR_KINDS.TIMEOUT);
  assert.equal((await first).maybeSent, true);
  // Report 1 asked; the late report 2 arrives meanwhile: dropped, kind differs.
  const second = channel.request(HOST, 'report 1', {
    expect: { kind: 'report', id: 1 },
    timeoutMs: 5000,
  });
  await advance(3000);
  assert.equal((await second).report.ID, '1');
});

test('commands go before the queued reads; a deadline passed is LATE, unsent', async (t) => {
  const net = fakeKeba({ [HOST]: { r1: report1(), r2: report2(), delay: 300 } });
  const { channel, advance } = await setup(t, net);
  const read1 = channel.request(HOST, 'report 1', {
    expect: { kind: 'report', id: 1 },
    timeoutMs: 2000,
  });
  const read2 = channel.request(HOST, 'report 2', REPORT2);
  const command = channel.request(HOST, 'ena 0', {
    expect: { kind: 'tch' },
    timeoutMs: 2000,
    priority: true,
  });
  const late = channel
    .request(HOST, 'ena 1', {
      expect: { kind: 'tch' },
      timeoutMs: 2000,
      startBy: Date.now() + 100,
      priority: true,
    })
    .catch((err) => err);
  await advance(3000);
  await Promise.all([read1, read2, command]);
  assert.deepEqual(net.payloads(), ['report 1', 'ena 0', 'report 2']);
  const err = await late;
  assert.equal(err.kind, ERROR_KINDS.LATE);
  assert.equal(err.maybeSent, false);
});

test('the pause after a command: gapAfter', async (t) => {
  const { channel, net, advance } = await setup(t);
  const a = channel.request(HOST, 'ena 0', {
    expect: { kind: 'tch' },
    timeoutMs: 1000,
    gapAfter: 2000,
  });
  const b = channel.request(HOST, 'report 2', REPORT2);
  await advance(2500);
  await Promise.all([a, b]);
  assert.ok(net.sent[1].at - net.sent[0].at >= 2000);
});

test('the port taken: a BIND error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const net = fakeKeba();
  net.bindError = 'EADDRINUSE';
  const channel = new KebaChannel({ createSocket: net.createSocket });
  const opening = channel.open().catch((err) => err);
  await settle();
  const err = await opening;
  assert.equal(err.kind, ERROR_KINDS.BIND);
  assert.match(err.message, /EADDRINUSE/);
});

test('closed: the queued requests are rejected', async (t) => {
  const net = fakeKeba({ [HOST]: { r1: report1(), r2: report2(), delay: 500 } });
  const { channel } = await setup(t, net);
  const a = channel.request(HOST, 'report 2', REPORT2).catch((err) => err);
  const b = channel.request(HOST, 'report 2', REPORT2).catch((err) => err);
  await settle();
  channel.close();
  assert.equal((await a).kind, ERROR_KINDS.CLOSED);
  assert.equal((await b).kind, ERROR_KINDS.CLOSED);
});
