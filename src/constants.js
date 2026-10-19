// -----------------------------------------------------------------------------
// KEBA KeContact UDP constants, feature roles, limits and timings.
//
// The UDP interface of a KeContact P20 / P30 (and the BMW wallboxes built on
// it), as keba-kecontact (MIT, dannerph/keba-kecontact, the library of Home
// Assistant) reads it, after KEBA's "UDP Programmers Guide": port 7090 both
// ways (the station answers to port 7090 of the sender), plain text, no
// authentication. "report 1" (identity), "report 2" (state), "report 3"
// (meter) answer a JSON object; a command ("ena 1", "curr 16000"...) answers
// "TCH-OK :done" or "TCH-ERR".
// -----------------------------------------------------------------------------

export const UDP_PORT = 7090;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'vehicle-plugged',
  CABLE_STATION: 'cable-station',
  CABLE_LOCKED: 'cable-locked',
  POWER: 'power',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  SESSION_ENERGY: 'session-energy',
  TOTAL_ENERGY: 'total-energy',
  MAX_CURRENT: 'max-current',
  ENABLED_SYSTEM: 'enabled-system',
  ENABLED_USER: 'enabled-user',
  FAILSAFE: 'failsafe',
  AUTH_REQUIRED: 'auth-required',
  ENABLE: 'enable-charge',
  DISABLE: 'disable-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The `State` of report 2 (keba-kecontact's State_details). */
export const STATE = {
  STARTING: 0,
  NOT_READY: 1,
  READY: 2,
  CHARGING: 3,
  ERROR: 4,
  AUTH_REJECTED: 5,
};

/**
 * The charging current: 6 A at least (IEC 61851; keba-kecontact refuses
 * 1-5 A), 63 A at most (keba-kecontact's validate_current), and never above
 * the hardware limit the station reports (`Curr HW`, read again just before
 * a command). `curr 0` (which stops the charge like `ena 0`) is never sent.
 */
export const CURRENT = {
  min: 6,
  max: 63,
  /** The select of a station whose hardware limit is not known yet stops at 32 A. */
  unknownHardwareMax: 32,
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Stations of one integration. */
  addresses: 8,
  /** A report is about 600 bytes: a larger datagram is dropped unread. */
  datagramBytes: 4096,
  /** Longest text kept from an answer (product, firmware). */
  textLength: 60,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /**
   * The station needs a pause between two messages: keba-kecontact waits
   * 100 ms after every message (reports included), 2 s after "ena 0".
   */
  gap: 100,
  gapAfterDisable: 2 * SECOND,
  /** One report of the polling (a station on the LAN answers in well under 1 s). */
  readTimeout: 2 * SECOND,
  /** Report 1 (identity, firmware) is read again every hour. */
  identityEvery: HOUR,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** UDP port 7090 taken: bound again after this delay. */
  bindRetry: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the stations at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 1.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [3 * SECOND, 15 * SECOND],
  /** A sent command keeps its guard until the state moves to what it asked, or 90 s. */
  guard: 90 * SECOND,
};
