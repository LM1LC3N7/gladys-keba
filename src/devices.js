// -----------------------------------------------------------------------------
// A station -> one Gladys device and its states (pure).
//
// `ext:<selector>:keba:<serial>`: one device per station, keyed by the serial
// number of report 1, never by its IP address (it may change). The feature
// roles (the last part of their external ids) are published forever: never
// rename them. Every role is always built, whatever the model (a station
// without a meter leaves its meter features empty), so a republished device
// never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command. The
// "ena" state is read only (`unknown/binary`); allowing and forbidding the
// charge are two `button/push` features, the charging current a
// `text/select` of the whole amperes from 6 A to the hardware limit of the
// station. All three refuse unless the configuration allows the commands
// (src/app.js). The failsafe mode is read only, never changed.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor`
// (instantaneous readings, never an index); kWh and A on
// `electrical-vehicle-charge`. The energy of the session and the total
// energy are plain sensors (`last-charge-energy-added`,
// `charge-energy-consumption-total`): never an `index`/`energy` feature, so
// the energy tab never counts them (the station is behind the main meter).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, FEATURES, STATE } from './constants.js';
import { FEATURE_NAMES, OFFLINE, STATE_NAMES, UNKNOWN_STATE, word } from './i18n.js';
import { plugFlags } from './keba/protocol.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const current = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 100,
});
const voltage = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.VOLTAGE,
  unit: U.VOLT,
  min: 0,
  max: 500,
});

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 }),
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.CABLE_STATION]: binary,
  [FEATURES.CABLE_LOCKED]: binary,
  [FEATURES.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 50_000,
  }),
  [FEATURES.CURRENT_L1]: current,
  [FEATURES.CURRENT_L2]: current,
  [FEATURES.CURRENT_L3]: current,
  [FEATURES.VOLTAGE_L1]: voltage,
  [FEATURES.VOLTAGE_L2]: voltage,
  [FEATURES.VOLTAGE_L3]: voltage,
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.TOTAL_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_CONSUMPTION_TOTAL,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 10_000_000,
  }),
  [FEATURES.MAX_CURRENT]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: CURRENT.max,
  }),
  [FEATURES.ENABLED_SYSTEM]: binary,
  [FEATURES.ENABLED_USER]: binary,
  [FEATURES.FAILSAFE]: binary,
  [FEATURES.AUTH_REQUIRED]: binary,
  [FEATURES.ENABLE]: button,
  [FEATURES.DISABLE]: button,
  [FEATURES.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.ENABLE, FEATURES.DISABLE, FEATURES.SET_CURRENT];

export const stationIds = (gladys, serial) => gladys.externalIds('keba', serial);

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:keba:([0-9A-Za-z]{1,32}):([a-z0-9-]+)$/.exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:keba:([0-9A-Za-z]{1,32})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** A hardware limit usable as a bound: a whole number of amperes, 6 to 63 A. */
export function hardwareLimit(amps) {
  return Number.isInteger(amps) && amps >= CURRENT.min && amps <= CURRENT.max ? amps : undefined;
}

export function currentOptions(ceiling) {
  const options = [];
  for (let amps = CURRENT.min; amps <= ceiling; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - CURRENT.min });
  }
  return options;
}

export const deviceName = (identity) =>
  `${identity.manufacturer} ${identity.model} ${identity.serial.slice(-4)}`;

/**
 * The Gladys device of one station. `ceiling`: the highest hardware limit
 * seen (the select never offers more; the command checks the limit read just
 * before sending anyway).
 */
export function buildDevice(gladys, { identity, ceiling }, language) {
  const ids = stationIds(gladys, identity.serial);
  const params = [
    { name: 'serial_number', value: identity.serial },
    { name: 'product', value: identity.product },
  ];
  if (identity.firmware) {
    params.push({ name: 'firmware', value: identity.firmware });
  }
  return {
    name: deviceName(identity),
    external_id: ids.device,
    model: `${identity.manufacturer} ${identity.model}`,
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT
        ? { supported_options: currentOptions(ceiling ?? CURRENT.unknownHardwareMax) }
        : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  if (state?.state === STATE.ERROR) {
    return CONNECTOR_STATUS.FAULTED;
  }
  if (state?.plug === undefined) {
    return undefined;
  }
  return state.plug >= 5 ? CONNECTOR_STATUS.OCCUPIED : CONNECTOR_STATUS.AVAILABLE;
}

/**
 * The charging state (OCPP's chargingState): no vehicle → IDLE, so a scene
 * never keeps reading "charging" after the car left.
 */
export function chargingStateOf(state) {
  if (state?.plug === undefined || state.state === undefined) {
    return undefined;
  }
  if (state.plug < 5 || state.state === STATE.ERROR) {
    return CHARGING_STATE.IDLE;
  }
  switch (state.state) {
    case STATE.CHARGING:
      return CHARGING_STATE.CHARGING;
    case STATE.NOT_READY:
    case STATE.AUTH_REJECTED:
      return CHARGING_STATE.PAUSED_BY_CHARGER;
    default:
      // Starting, or ready and waiting for the vehicle.
      return CHARGING_STATE.EV_CONNECTED;
  }
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The text of the status feature. */
export const statusText = (state, language) =>
  word(STATE_NAMES[state?.state] ?? UNKNOWN_STATE, language);

/**
 * The current values of one station's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others).
 */
export function deviceStates(ids, station, { online, language }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(OFFLINE, language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const s = station.state;
  if (s) {
    states.push({ role: FEATURES.STATUS, text: statusText(s, language) });
    add(FEATURES.CONNECTOR, connectorOf(s));
    add(FEATURES.CHARGING_STATE, chargingStateOf(s));
    const plug = plugFlags(s.plug);
    add(FEATURES.PLUGGED, plug.vehicle);
    add(FEATURES.CABLE_STATION, plug.station);
    add(FEATURES.CABLE_LOCKED, plug.locked);
    if (s.maxCurrent !== undefined) add(FEATURES.MAX_CURRENT, round(s.maxCurrent, 1));
    add(FEATURES.ENABLED_SYSTEM, s.enableSys);
    add(FEATURES.ENABLED_USER, s.enableUser);
    if (s.failsafeTimeout !== undefined) add(FEATURES.FAILSAFE, s.failsafeTimeout > 0 ? 1 : 0);
    add(FEATURES.AUTH_REQUIRED, s.authRequired);
    const ceiling = hardwareLimit(s.hardwareCurrent) ?? station.ceiling;
    if (
      Number.isInteger(s.userCurrent) &&
      s.userCurrent >= CURRENT.min &&
      s.userCurrent <= (ceiling ?? CURRENT.max)
    ) {
      states.push({ role: FEATURES.SET_CURRENT, text: String(s.userCurrent) });
    }
  }
  const m = station.meter;
  if (m) {
    if (m.power !== undefined) add(FEATURES.POWER, Math.round(m.power));
    const phases = [
      [FEATURES.CURRENT_L1, FEATURES.VOLTAGE_L1],
      [FEATURES.CURRENT_L2, FEATURES.VOLTAGE_L2],
      [FEATURES.CURRENT_L3, FEATURES.VOLTAGE_L3],
    ];
    for (const [i, [currentRole, voltageRole]] of phases.entries()) {
      if (m.currents[i] !== undefined) add(currentRole, round(m.currents[i], 2));
      if (m.voltages[i] !== undefined) add(voltageRole, Math.round(m.voltages[i]));
    }
    if (m.sessionEnergy !== undefined) add(FEATURES.SESSION_ENERGY, round(m.sessionEnergy, 3));
    // Never 0 after a value (a reset glitch): a plain sensor, yet a chart would show a drop.
    if (m.totalEnergy !== undefined && m.totalEnergy > 0) {
      add(FEATURES.TOTAL_ENERGY, round(m.totalEnergy, 3));
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
