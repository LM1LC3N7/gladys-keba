// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
//
// Only IPv4 addresses: an answer is attributed to its request by the address
// it comes from, which a host name cannot be compared with (keba-kecontact
// also requires an IP address).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/**
 * A unicast IPv4 address typed by the user (no leading zeros), else
 * undefined. Refused: 0.0.0.0/8, loopback 127/8, multicast and reserved
 * (224 and above, broadcast included), and an address ending in .255 (the
 * broadcast of a home /24 network): a command must reach one station only.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '').trim();
  if (isIP(text) !== 4) {
    return undefined;
  }
  const parts = text.split('.').map(Number);
  if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224 || parts[3] === 255) {
    return undefined;
  }
  return parts.join('.');
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push({ text: entry.slice(0, 100), reason: 'invalid' });
    } else if (addresses.includes(address)) {
      // The same address twice: read once.
    } else if (addresses.length >= LIMITS.addresses) {
      // Never dropped silently: shown with its reason.
      invalid.push({ text: address, reason: 'too_many' });
    } else {
      addresses.push(address);
    }
  }
  const interval = Number(c.poll_interval);
  return {
    addresses,
    invalid,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
