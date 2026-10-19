// -----------------------------------------------------------------------------
// The integration: the stations typed in the configuration (IPv4 addresses),
// their reports read every poll interval over the UDP channel, the Gladys
// devices and their states, the transport badge, the "Test the connection"
// button, and the three commands (allow charging, forbid charging, charging
// current), refused unless the configuration allows them. index.js only wires
// the SDK handlers to it.
//
// Commands follow the rules learnt on the previous modules:
//   - decided on a fresh "report 2" of the station only, never on the state
//     kept in memory, and refused when a value they need is missing;
//   - the "Allow the commands" option is checked on arrival and again right
//     before sending;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command without an answer (it may have reached the station) is never
//     answered "not sent": "sent, without confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time per station, except "forbid charging", which is
//     never refused for a command in flight; never retried.
// The failsafe mode is read only: no command ever changes it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { CURRENT, FEATURES, PRESSED, SECOND, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceStates,
  deviceName,
  hardwareLimit,
  parseDeviceId,
  parseFeatureId,
  stationIds,
} from './devices.js';
import { ERRORS, T, age, summaryOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { ERROR_KINDS, KebaChannel } from './keba/channel.js';
import { ANSWER, COMMANDS, identityOf, meterOf, stateOf } from './keba/protocol.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

const REPORT = (id) => ({ kind: 'report', id });
const TCH = { kind: 'tch' };

/** Our own words for a channel error: never a text of the station. */
const reasonOf = (err) => (err?.kind ? String(err.kind) : 'error');

/** An error of a read: `kind` drives the status and the backoff. */
class ReadError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export class KebaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'keba' }),
    channel,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.channel = channel ?? new KebaChannel({ now, timers });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.raw = {};
    this.config = normalizeConfig();
    /** address -> station: { address, identity, state, meter, ceiling, online, failures, wait, timer, running, followUps, error, identityAt, meterFailing }. */
    this.stations = new Map();
    this.generation = 0;
    this.started = false;
    this.bindError = undefined;
    this.bindTimer = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** serial -> the command in flight: { role, seq }. */
    this.inFlight = new Map();
    /** serial -> number of commands that arrived; serial -> number of the last "forbid". */
    this.commandCount = new Map();
    this.lastDisable = new Map();
    /** `${serial}:${kind}` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await Promise.all([...this.stations.values()].map((s) => s.running));
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    this.stations = new Map(
      this.config.addresses.map((address) => [
        address,
        {
          address,
          identity: undefined,
          identityAt: undefined,
          state: undefined,
          meter: undefined,
          ceiling: undefined,
          online: undefined,
          failures: 0,
          wait: undefined,
          timer: undefined,
          running: undefined,
          followUps: new Set(),
          error: undefined,
          meterFailing: false,
        },
      ]),
    );
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (this.stations.size === 0) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    if (!(await this.openChannel())) {
      return;
    }
    await this.setStatus(false, this.withInvalid(T.connecting));
    await Promise.all([...this.stations.values()].map((station) => this.tick(station)));
  }

  /** Binds UDP port 7090; on failure, says so and tries again in a minute. */
  async openChannel() {
    try {
      await this.channel.open();
      this.bindError = undefined;
      return true;
    } catch (err) {
      this.bindError = err;
      this.logger.warn(`KEBA: UDP port 7090 not available (${err.message})`);
      const generation = this.generation;
      this.bindTimer = this.timers.setTimeout(() => {
        this.bindTimer = undefined;
        if (generation === this.generation) {
          this.start(this.raw).catch(() => this.logger.error('KEBA start failed'));
        }
      }, TIMINGS.bindRetry);
      await this.publishAll();
      return false;
    }
  }

  stop() {
    this.generation += 1;
    if (this.bindTimer) {
      this.timers.clearTimeout(this.bindTimer);
      this.bindTimer = undefined;
    }
    for (const station of this.stations.values()) {
      this.clearTimer(station);
      for (const handle of station.followUps) {
        this.timers.clearTimeout(handle);
      }
      station.followUps.clear();
    }
    this.publisher.stop();
  }

  /** The container stops: the socket is released too. */
  shutdown() {
    this.stop();
    this.channel.close();
  }

  clearTimer(station) {
    if (station.timer) {
      this.timers.clearTimeout(station.timer);
      station.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      JSON.stringify(next.addresses) !== JSON.stringify(this.config.addresses) ||
      JSON.stringify(next.invalid) !== JSON.stringify(this.config.invalid)
    );
  }

  /** New addresses or interval restart; the option and the language apply at once. */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.raw = raw ?? {};
    this.config = normalizeConfig(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`KEBA commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The next read of a station: after its backoff, else the interval. */
  schedule(station, delay) {
    this.clearTimer(station);
    const wait = delay ?? (station.online === false ? station.wait : this.interval);
    const generation = this.generation;
    station.timer = this.timers.setTimeout(
      () => {
        station.timer = undefined;
        if (generation === this.generation) {
          this.tick(station).catch(() => this.logger.error('KEBA refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time per station: a tick during a read joins it. */
  tick(station) {
    if (!station.running) {
      station.running = this.run(station).finally(() => {
        station.running = undefined;
      });
    }
    return station.running;
  }

  async run(station) {
    const generation = this.generation;
    try {
      const read = await this.read(station);
      if (generation !== this.generation) {
        return;
      }
      this.applyRead(station, read);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      this.failed(station, err);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(station);
    }
  }

  /** One report, the answer of the station at `address` only. */
  async report(address, id, options = {}) {
    const answer = await this.channel.request(address, `report ${id}`, {
      expect: REPORT(id),
      timeoutMs: TIMINGS.readTimeout,
      ...options,
    });
    return answer.report;
  }

  /**
   * The reads of a cycle: report 1 when the identity is unknown or an hour
   * old, report 2 (the state), and report 3 (the meter) for a station that
   * has one. A report 3 that fails never fails the cycle: the state is
   * published, the meter keeps its last values.
   */
  async read(station) {
    let identity = station.identity;
    let identityAt = station.identityAt;
    const identify = async () => {
      identity = identityOf(await this.report(station.address, 1));
      identityAt = this.now();
      if (!identity) {
        throw new ReadError('no_id', 'report 1 without serial or product');
      }
    };
    if (!identity || this.now() - identityAt >= TIMINGS.identityEvery || this.now() < identityAt) {
      await identify();
    }
    let state = stateOf(await this.report(station.address, 2));
    if (state?.serial && state.serial !== identity.serial) {
      // Another station at this address now: identified again.
      await identify();
      state = stateOf(await this.report(station.address, 2));
    }
    if (!state || state.serial !== identity.serial) {
      throw new ReadError('no_id', 'report 2 of another station or without serial');
    }
    let meter;
    let meterFailing = false;
    if (identity.meter) {
      try {
        meter = meterOf(await this.report(station.address, 3));
        if (meter?.serial !== identity.serial) {
          meter = undefined;
        }
      } catch {
        meterFailing = true;
      }
    }
    return { identity, identityAt, state, meter, meterFailing };
  }

  /** A read answered: the station as read, and the guards it may lift. */
  applyRead(station, { identity, identityAt, state, meter, meterFailing }) {
    if (station.identity && station.identity.serial !== identity.serial) {
      // Another station: its own ceiling and meter.
      station.ceiling = undefined;
      station.meter = undefined;
    }
    station.identity = identity;
    station.identityAt = identityAt;
    station.state = state;
    if (meter) {
      station.meter = meter;
    }
    if (meterFailing !== station.meterFailing) {
      this.logger.warn(
        `KEBA ${station.address}: report 3 ${meterFailing ? 'unavailable' : 'back'}`,
      );
    }
    station.meterFailing = meterFailing;
    station.online = true;
    station.failures = 0;
    station.wait = undefined;
    station.error = undefined;
    this.updateCeiling(station, state);
    this.observe(identity.serial, state);
  }

  /** The highest hardware limit seen: the select never offers less after a cable unplugged. */
  updateCeiling(station, state) {
    const limit = hardwareLimit(state?.hardwareCurrent);
    if (limit !== undefined && (station.ceiling === undefined || limit > station.ceiling)) {
      station.ceiling = limit;
    }
  }

  failed(station, err) {
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(station.failures, TIMINGS.backoff.length - 1)],
    );
    station.failures += 1;
    station.wait = wait;
    station.online = false;
    station.error = reasonOf(err);
    if (err?.kind === 'no_id') {
      // It answers, but not as a station we can add: identified again next time.
      station.identity = undefined;
    }
    this.logger.warn(
      `KEBA ${station.address}: ${station.error}; next try in ${Math.round(wait / 1000)} s`,
    );
  }

  withInvalid(message) {
    return this.config.invalid.length > 0 ? join(message, T.invalid(this.config.invalid)) : message;
  }

  summary(station) {
    return summaryOf({
      name: deviceName(station.identity),
      state: station.state?.state,
      power: station.meter?.power === undefined ? undefined : Math.round(station.meter.power),
      maxCurrent: station.state?.maxCurrent,
    });
  }

  /** The connection status of the configuration screen, from every station. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === stationIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.orphans(names)));
  }

  /**
   * `[connected, message, plain]` from the configured stations; `plain`:
   * the same summary without "Connected", for a status shown as not connected.
   */
  status() {
    const stations = [...this.stations.values()];
    if (stations.length === 0) {
      return [
        false,
        this.config.invalid.length > 0
          ? join(T.noAddress, T.invalid(this.config.invalid))
          : T.noAddress,
      ];
    }
    if (this.bindError) {
      return [false, this.withInvalid(T.portBusy(age(TIMINGS.bindRetry)))];
    }
    const noId = stations.filter((s) => s.error === 'no_id');
    if (noId.length > 0) {
      return [false, this.withInvalid(T.noId)];
    }
    const down = stations.filter((s) => s.online === false);
    if (down.length > 0) {
      const wait = Math.min(...down.map((s) => s.wait ?? this.interval));
      return [
        false,
        this.withInvalid(T.unreachable(down.map((s) => s.address).join(', '), age(wait))),
      ];
    }
    if (stations.some((s) => s.online === undefined)) {
      return [false, this.withInvalid(T.connecting)];
    }
    const summaries = stations.map((s) => this.summary(s));
    const summary = both(
      summaries.map((m) => m.en).join(' '),
      summaries.map((m) => m.fr).join(' '),
    );
    return [true, this.withInvalid(T.connected(summary)), this.withInvalid(summary)];
  }

  // --- Gladys ----------------------------------------------------------------

  /**
   * The stations identified, one per serial: an address online wins over one
   * that stopped answering, else the first address.
   */
  known() {
    const bySerial = new Map();
    for (const station of this.stations.values()) {
      const serial = station.identity?.serial;
      if (!serial || !station.state) {
        continue;
      }
      const held = bySerial.get(serial);
      if (!held || (held.online === false && station.online !== false)) {
        bySerial.set(serial, station);
      }
    }
    return bySerial;
  }

  /**
   * The serials of the devices created in Gladys that no station read gives
   * (an address removed, or a station that never answered since the start).
   * Empty while a first read is still under way.
   */
  orphans() {
    if ([...this.stations.values()].some((s) => s.online === undefined)) {
      return [];
    }
    const known = this.known();
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        !known.has(serial) &&
        stationIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  stationOf(serial) {
    return this.known().get(serial);
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const devices = [...this.known().values()].map((s) =>
      buildDevice(this.gladys, s, this.config.language),
    );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (states) => {
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    for (const [serial, station] of this.known()) {
      push(
        deviceStates(stationIds(this.gladys, serial), station, {
          online: station.online !== false,
          language: this.config.language,
        }),
      );
    }
    // A created device no station gives: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(
        deviceStates(
          stationIds(this.gladys, serial),
          {},
          { online: false, language: this.config.language },
        ),
      );
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const [serial, station] of this.known()) {
      const externalId = stationIds(this.gladys, serial).device;
      if (created.has(externalId)) {
        entries.push({
          external_id: externalId,
          transport:
            station.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
        });
      }
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: stationIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last reads, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  async testConnection() {
    if (this.stations.size === 0) {
      return this.config.invalid.length > 0
        ? join(T.noAddress, T.invalid(this.config.invalid))
        : T.noAddress;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown && this.now() >= this.lastTestAt) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    if (this.bindError) {
      // Bound again now rather than in a minute.
      await this.start(this.raw);
    } else {
      // A read now of every station (a read in progress is joined).
      await Promise.all([...this.stations.values()].map((station) => this.tick(station)));
    }
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 12.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.ENABLE || role === FEATURES.DISABLE) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,2}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    const { serial, role } = target;
    const seq = (this.commandCount.get(serial) ?? 0) + 1;
    this.commandCount.set(serial, seq);
    if (role === FEATURES.DISABLE) {
      this.lastDisable.set(serial, seq);
    }
    // One command at a time per station; "forbid charging" is never refused
    // for a command in flight (it goes after it on the channel).
    const previous = this.inFlight.get(serial);
    if (previous && (role !== FEATURES.DISABLE || previous.role === FEATURES.DISABLE)) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = { role, seq };
    this.inFlight.set(serial, entry);
    try {
      return await this.command(target, wanted, received, entry);
    } finally {
      if (this.inFlight.get(serial) === entry) {
        this.inFlight.delete(serial);
      }
    }
  }

  /** What to send, from the state just read; undefined when it is already so. */
  plan(role, wanted, state, serial) {
    if (role === FEATURES.ENABLE || role === FEATURES.DISABLE) {
      if (state.enableUser === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      const expected = role === FEATURES.ENABLE ? 1 : 0;
      if (state.enableUser === expected && !this.guardActive(serial, 'ena')) {
        return undefined;
      }
      return {
        payload: expected ? COMMANDS.enable() : COMMANDS.disable(),
        kind: 'ena',
        from: state.enableUser,
        expected,
        gapAfter: expected ? 0 : TIMINGS.gapAfterDisable,
      };
    }
    const limit = hardwareLimit(state.hardwareCurrent);
    if (limit === undefined) {
      throw this.refusal(ERRORS.unknownBounds);
    }
    if (wanted < CURRENT.min || wanted > limit) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, limit));
    }
    if (state.userCurrent === wanted && !this.guardActive(serial, 'curr')) {
      return undefined;
    }
    return {
      payload: COMMANDS.current(wanted),
      kind: 'curr',
      from: state.userCurrent,
      expected: wanted,
      gapAfter: 0,
    };
  }

  /** The checks before sending, on the latest configuration. */
  checkBeforeSend(generation, serial) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.stationOf(serial)) {
      throw this.refusal(ERRORS.unknownStation);
    }
  }

  async command({ serial, role }, wanted, received, entry) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    this.checkBeforeSend(generation, serial);
    const station = this.stationOf(serial);
    if (!station.identity.recognized) {
      throw this.refusal(ERRORS.unsupported(station.identity.product));
    }
    const readBy = sendBy - TIMINGS.commandMinSend;
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }

    // The state just before acting, never the one in memory.
    let state;
    try {
      const answer = await this.channel.request(station.address, 'report 2', {
        expect: REPORT(2),
        timeoutMs: TIMINGS.commandReadMax,
        startBy: readBy - TIMINGS.commandMinRead,
        answerBy: readBy,
        priority: true,
      });
      state = stateOf(answer.report);
    } catch (err) {
      if (err?.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownStation);
    }
    if (!state || state.serial === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    if (state.serial !== serial) {
      throw this.refusal(ERRORS.otherStation);
    }
    station.state = state;
    this.updateCeiling(station, state);
    this.observe(serial, state);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));

    const plan = this.plan(role, wanted, state, serial);
    if (!plan) {
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, serial);
    if (role !== FEATURES.DISABLE && (this.lastDisable.get(serial) ?? 0) > entry.seq) {
      throw this.refusal(ERRORS.disableMeanwhile);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`KEBA ${station.address}: ${plan.payload}`);
    let answer;
    try {
      answer = await this.channel.request(station.address, plan.payload, {
        expect: TCH,
        timeoutMs: TIMINGS.commandAnswerBy,
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        gapAfter: plan.gapAfter,
        priority: true,
      });
    } catch (err) {
      this.logger.warn(`KEBA ${station.address}: ${plan.payload} failed (${reasonOf(err)})`);
      if (err?.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (!err?.maybeSent) {
        throw this.refusal(ERRORS.notSent(reasonOf(err)));
      }
      // No answer: it may have reached the station.
      this.guard(serial, plan);
      this.followUp(station);
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
    this.followUp(station);
    if (answer.kind === ANSWER.TCH_ERR) {
      throw this.refusal(ERRORS.refused);
    }
    this.guard(serial, plan);
  }

  /** Spaced reads after a command: its effect, then a check. */
  followUp(station) {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        station.followUps.delete(handle);
        if (generation === this.generation) {
          this.tick(station).catch(() => this.logger.error('KEBA refresh failed'));
        }
      }, delay);
      station.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until the station shows it: a new command of the same
   * kind is always sent, never answered "already so" on a state that may not
   * show the previous one yet. The start state is kept: a read equal to it
   * lifts nothing until a move was seen.
   */
  guard(serial, plan) {
    this.guards.set(`${serial}:${plan.kind}`, {
      from: plan.from,
      expected: plan.expected,
      moved: plan.from === undefined,
      until: this.now() + TIMINGS.guard,
    });
  }

  guardActive(serial, kind) {
    const key = `${serial}:${kind}`;
    const guard = this.guards.get(key);
    if (guard && (this.now() >= guard.until || this.now() < guard.until - TIMINGS.guard)) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of a station, through its guards: never lifted on an unknown value. */
  observe(serial, state) {
    for (const [kind, value] of [
      ['ena', state?.enableUser],
      ['curr', state?.userCurrent],
    ]) {
      if (!this.guardActive(serial, kind) || value === undefined) {
        continue;
      }
      const guard = this.guards.get(`${serial}:${kind}`);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(`${serial}:${kind}`);
      }
    }
  }
}
