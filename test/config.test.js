import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 only, deduplicated, eight at most', () => {
  assert.equal(parseAddress(' 192.168.1.60 '), '192.168.1.60');
  for (const bad of [
    'keba.local',
    '192.168.1',
    '192.168.1.300',
    'http://192.168.1.60',
    '::1',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const many = Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`).join(', ');
  const c = normalizeConfig({ addresses: `10.0.0.1 10.0.0.1; ${many}, nope` });
  assert.equal(c.addresses.length, 8);
  assert.deepEqual(
    c.invalid.map((i) => i.reason),
    ['too_many', 'too_many', 'invalid'],
  );
});

test('commands only with a strict true; interval bounded; language', () => {
  assert.equal(normalizeConfig().allowCommands, false);
  for (const value of ['yes', 1, '1', 'TRUE', null, undefined, {}]) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 30);
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
});
