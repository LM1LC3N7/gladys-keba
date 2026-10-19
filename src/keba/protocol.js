// -----------------------------------------------------------------------------
// The KEBA UDP protocol, pure: what an answer is, what the reports say, which
// station a product string describes, and the command texts. Ported from
// keba-kecontact 4.3.1 (MIT, Philipp Danner): utils.get_response_type,
// charging_station.datagram_received (units) and charging_station_info
// (product string). Every value is read with its exact type from the own
// fields of a plain object: an answer is untrusted.
// -----------------------------------------------------------------------------

import { CURRENT, LIMITS } from '../constants.js';

/** The kinds of answer (keba-kecontact's KebaResponse, those we use). */
export const ANSWER = {
  REPORT: 'report',
  TCH_OK: 'tch-ok',
  TCH_ERR: 'tch-err',
  BROADCAST: 'broadcast',
  PUSH: 'push',
  UNKNOWN: 'unknown',
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** An own field of `object`, else undefined (never the prototype's). */
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

/** A finite number (or an integer written as a string, as `ID` and `Serial` may be). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,15}\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

const integerOf = (value) => {
  const n = numberOf(value);
  return Number.isInteger(n) ? n : undefined;
};

/** A short printable text, else undefined. */
function textOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, LIMITS.textLength);
  return text === '' ? undefined : text;
}

/** A serial number usable in an external id: letters and digits only. */
function serialOf(value) {
  const text = textOf(value);
  return text && /^[0-9A-Za-z]{1,32}$/.test(text) ? text : undefined;
}

/**
 * What a datagram is: `{ kind, id?, report? }`. A report is a JSON object
 * with an `ID` (1, 2, 3, 1xx); "TCH-OK" / "TCH-ERR" answer a command; "i"
 * and `"Firmware...` are the broadcast and the discovery answer; a JSON
 * object without `ID` is a push message the station sends by itself.
 */
export function classify(text) {
  if (typeof text !== 'string') {
    return { kind: ANSWER.UNKNOWN };
  }
  if (text.startsWith('i') || text.startsWith('"Firmware')) {
    return { kind: ANSWER.BROADCAST };
  }
  if (text.includes('TCH-OK')) {
    return { kind: ANSWER.TCH_OK };
  }
  if (text.includes('TCH-ERR')) {
    return { kind: ANSWER.TCH_ERR };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: ANSWER.UNKNOWN };
  }
  if (!isPlainObject(json)) {
    return { kind: ANSWER.UNKNOWN };
  }
  if (!Object.hasOwn(json, 'ID')) {
    return { kind: ANSWER.PUSH };
  }
  const id = integerOf(json.ID);
  return id === undefined ? { kind: ANSWER.UNKNOWN } : { kind: ANSWER.REPORT, id, report: json };
}

/**
 * The station a "report 1" describes (keba-kecontact's ChargingStationInfo):
 * `{ serial, firmware, product, manufacturer, model, meter, recognized }`,
 * or undefined when the report lacks its serial or product.
 *
 * `Product` is "<maker>-<model>-<version>-<features>", e.g.
 * "KC-P30-EC240422-E00": KC (KEBA) or BMW; P20 or P30. A P30 has a meter,
 * except the "Deutschland Edition" (KC-P30-EC220112-000-DE); a P20 has one
 * in its b and c series (version ending in 10, 20 or 30), not in its
 * e-series (ending in 01). The BMW wallboxes have one. `recognized`: a maker
 * keba-kecontact knows (KC, BMW); the commands are refused otherwise.
 */
export function identityOf(report) {
  if (!isPlainObject(report) || integerOf(own(report, 'ID')) !== 1) {
    return undefined;
  }
  const serial = serialOf(own(report, 'Serial'));
  const product = textOf(own(report, 'Product'));
  if (!serial || !product) {
    return undefined;
  }
  const firmware = textOf(own(report, 'Firmware'));
  const parts = product.split('-');
  const identity = {
    serial,
    firmware,
    product,
    manufacturer: parts[0] || 'KEBA',
    model: parts[1] || 'KeContact',
    meter: false,
    recognized: false,
  };
  if (parts.length < 4) {
    return identity;
  }
  const version = parts[2];
  if (parts[0] === 'KC') {
    identity.manufacturer = 'KEBA';
    if (parts[1] === 'P30') {
      identity.recognized = true;
      if (product.includes('KC-P30-EC220112-000-DE')) {
        identity.model = 'P30-DE';
        identity.meter = false;
      } else {
        identity.meter = true;
      }
    } else if (parts[1] === 'P20') {
      identity.recognized = true;
      identity.meter = /(?:10|20|30)$/.test(version);
    }
  } else if (parts[0] === 'BMW') {
    identity.manufacturer = 'BMW';
    identity.recognized = true;
    identity.meter = true;
    if (product.includes('BMW-10-EC2405B2-E1R')) {
      identity.model = 'Wallbox Connect';
    } else if (product.includes('BMW-10-EC240522-E1R') || product.includes('BMW-10-ESS40022-E1R')) {
      identity.model = 'Wallbox Plus';
    } else {
      identity.model = 'Wallbox';
    }
  }
  return identity;
}

/** A milli-unit field (mA, mW...) as units, or undefined. */
const milli = (report, key) => {
  const n = numberOf(own(report, key));
  return n === undefined || n < 0 ? undefined : n / 1000;
};

/** A flag 0/1, or undefined. */
const flag = (report, key) => {
  const n = integerOf(own(report, key));
  return n === 0 || n === 1 ? n : undefined;
};

/**
 * Report 2, the state: `{ serial, state, plug, enableSys, enableUser,
 * maxCurrent, hardwareCurrent, userCurrent, failsafeTimeout, failsafeCurrent,
 * authRequired }`. Currents in A (the station gives mA). `Curr HW` at 0 means
 * "unknown" (keba-kecontact drops it): undefined here.
 */
export function stateOf(report) {
  if (!isPlainObject(report) || integerOf(own(report, 'ID')) !== 2) {
    return undefined;
  }
  const state = integerOf(own(report, 'State'));
  const plug = integerOf(own(report, 'Plug'));
  const hardware = milli(report, 'Curr HW');
  const timeout = integerOf(own(report, 'Tmo FS'));
  return {
    serial: serialOf(own(report, 'Serial')),
    state: state !== undefined && state >= 0 && state <= 5 ? state : undefined,
    plug: plug !== undefined && plug >= 0 && plug <= 7 ? plug : undefined,
    enableSys: flag(report, 'Enable sys'),
    enableUser: flag(report, 'Enable user'),
    maxCurrent: milli(report, 'Max curr'),
    hardwareCurrent: hardware > 0 ? hardware : undefined,
    userCurrent: milli(report, 'Curr user'),
    failsafeTimeout: timeout !== undefined && timeout >= 0 ? timeout : undefined,
    failsafeCurrent: milli(report, 'Curr FS'),
    authRequired: flag(report, 'Authreq'),
  };
}

/**
 * Report 3, the meter: `{ serial, voltages: [V], currents: [A], power (W),
 * sessionEnergy (kWh), totalEnergy (kWh) }`. The station gives mA, mW and
 * tenths of Wh.
 */
export function meterOf(report) {
  if (!isPlainObject(report) || integerOf(own(report, 'ID')) !== 3) {
    return undefined;
  }
  const volts = (key) => {
    const n = numberOf(own(report, key));
    return n === undefined || n < 0 ? undefined : n;
  };
  const tenthsOfWh = (key) => {
    const n = numberOf(own(report, key));
    return n === undefined || n < 0 ? undefined : n / 10_000;
  };
  const power = milli(report, 'P');
  return {
    serial: serialOf(own(report, 'Serial')),
    voltages: [volts('U1'), volts('U2'), volts('U3')],
    currents: [milli(report, 'I1'), milli(report, 'I2'), milli(report, 'I3')],
    power: power === undefined ? undefined : power,
    sessionEnergy: tenthsOfWh('E pres'),
    totalEnergy: tenthsOfWh('E total'),
  };
}

/** Plug codes: 0 nothing, 1 cable at the station, 3 + locked, 5 + vehicle, 7 + vehicle and locked. */
export const plugFlags = (plug) =>
  plug === undefined
    ? {}
    : {
        station: plug > 0 ? 1 : 0,
        locked: plug === 3 || plug === 7 ? 1 : 0,
        vehicle: plug >= 5 ? 1 : 0,
      };

/** The command texts (keba-kecontact's set_ena and set_current_max_permanent). */
export const COMMANDS = {
  enable: () => 'ena 1',
  disable: () => 'ena 0',
  current: (amps) => {
    if (!Number.isInteger(amps) || amps < CURRENT.min || amps > CURRENT.max) {
      throw new RangeError('current out of bounds');
    }
    return `curr ${amps * 1000}`;
  },
};
