// -----------------------------------------------------------------------------
// The UDP channel to the stations: one socket bound to port 7090 (a station
// answers to port 7090 of the sender, whatever the source port, as
// keba-kecontact binds it), ONE request at a time for all the stations, and
// the pauses the stations need: 100 ms between two messages on the channel,
// and, per station, 2 s after its "ena 0" (as keba-kecontact). A station in
// its pause never holds back the others.
//
// An answer counts only for the request in flight, only from the IP address
// it was sent to, and only of the kind it expects (report 2 for "report 2",
// TCH-OK / TCH-ERR for a command). Anything else (another station, a push
// message, a datagram over 4 KB) is dropped.
//
// Late answers: after a request of a station went unanswered (timeout, or
// its wait released by `abandon`), the next answer of that kind from that
// station within 10 s may be the late one. It is dropped when nothing waits
// for it; when a request waits, it is given with `unsure: true` (the caller
// never takes it as a confirmation nor as a sure state).
//
// Priorities: a higher `priority` goes first among the requests ready to
// leave ("forbid charging" 2, other commands 1, polling 0). `beforeSend` is
// called right before a request leaves: when it throws, nothing is sent and
// the request rejects with that error.
// -----------------------------------------------------------------------------

import { createSocket as dgramSocket } from 'node:dgram';
import { LIMITS, TIMINGS, UDP_PORT } from '../constants.js';
import { ANSWER, classify } from './protocol.js';

export const ERROR_KINDS = {
  /** The socket could not be bound (port 7090 taken): nothing sent. */
  BIND: 'bind',
  /** The send itself failed (no route...): nothing left. */
  SEND: 'send',
  /** Sent, no answer in time: it may have reached the station. */
  TIMEOUT: 'timeout',
  /** Sent, its wait released by `abandon` (a "forbid" needs the channel). */
  ABANDONED: 'abandoned',
  /** Could not leave before its deadline (channel busy): nothing sent. */
  LATE: 'late',
  /** The channel was closed: nothing sent, unless it was waiting for its answer. */
  CLOSED: 'closed',
};

export class ChannelError extends Error {
  constructor(kind, message, { maybeSent } = {}) {
    super(message);
    this.name = 'ChannelError';
    this.kind = kind;
    /** Whether the datagram may have reached the station. */
    this.maybeSent = maybeSent ?? (kind === ERROR_KINDS.TIMEOUT || kind === ERROR_KINDS.ABANDONED);
  }
}

const normalizeIp = (address) =>
  String(address ?? '')
    .toLowerCase()
    .replace(/^::ffff:/, '');

/** The kind of an answer for the late-answer bookkeeping: 'r<N>', 'tch', or undefined. */
function keyOf(answer) {
  if (answer.kind === ANSWER.REPORT) return `r${answer.id}`;
  if (answer.kind === ANSWER.TCH_OK || answer.kind === ANSWER.TCH_ERR) return 'tch';
  return undefined;
}

const expectKey = (expect) => (expect.kind === 'report' ? `r${expect.id}` : 'tch');

/** Whether an answer is the one `expect` waits for. */
function matches(expect, answer) {
  if (expect.kind === 'report') {
    return answer.kind === ANSWER.REPORT && answer.id === expect.id;
  }
  return answer.kind === ANSWER.TCH_OK || answer.kind === ANSWER.TCH_ERR;
}

export class KebaChannel {
  constructor({
    createSocket = dgramSocket,
    port = UDP_PORT,
    now = Date.now,
    timers = globalThis,
  } = {}) {
    this.createSocket = createSocket;
    this.port = port;
    this.now = now;
    this.timers = timers;
    this.socket = undefined;
    this.opening = undefined;
    /** Queued requests, in arrival order (picked by priority, then order). */
    this.queue = [];
    this.running = false;
    this.wake = undefined;
    /** The request waiting for its answer: { job, done }. */
    this.pending = undefined;
    /** No message leaves before this time (100 ms after the previous one). */
    this.readyAt = 0;
    /** host -> no message to that station before this time (2 s after its "ena 0"). */
    this.hostReadyAt = new Map();
    /** `${host}|${key}` -> { count, until }: answers that may still arrive late. */
    this.stale = new Map();
    this.dropped = 0;
  }

  /** Binds the socket once; resolves when ready, rejects with a BIND error. */
  open() {
    if (this.socket) {
      return Promise.resolve();
    }
    if (!this.opening) {
      this.opening = new Promise((resolve, reject) => {
        let socket;
        try {
          socket = this.createSocket({ type: 'udp4' });
        } catch (err) {
          reject(new ChannelError(ERROR_KINDS.BIND, `socket: ${err?.code ?? 'error'}`));
          return;
        }
        const failed = (err) => {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
          reject(new ChannelError(ERROR_KINDS.BIND, `bind ${this.port}: ${err?.code ?? 'error'}`));
        };
        socket.once('error', failed);
        socket.on('message', (datagram, rinfo) => this.received(datagram, rinfo));
        socket.bind(this.port, () => {
          socket.off('error', failed);
          // A later socket error never crashes the process: the requests time out.
          socket.on('error', () => {});
          this.socket = socket;
          resolve();
        });
      }).finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  /**
   * Closes the socket. The queued requests reject unsent; the one waiting
   * for its answer was sent: it rejects as "maybe sent".
   */
  close() {
    const socket = this.socket;
    this.socket = undefined;
    for (const job of this.queue.splice(0)) {
      job.reject(new ChannelError(ERROR_KINDS.CLOSED, 'channel closed'));
    }
    if (this.pending) {
      this.pending.done(
        new ChannelError(ERROR_KINDS.CLOSED, 'channel closed', { maybeSent: true }),
      );
    }
    this.wake?.();
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  /** An answer of `host` may still arrive late (its request went unanswered). */
  addStale(host, key) {
    const id = `${host}|${key}`;
    const entry = this.stale.get(id);
    const until = this.now() + TIMINGS.lateAnswerQuarantine;
    this.stale.set(id, { count: (entry && this.now() < entry.until ? entry.count : 0) + 1, until });
  }

  /** Whether an answer of `host` of this kind may be a late one; it is then counted off. */
  consumeStale(host, key) {
    const id = `${host}|${key}`;
    const entry = this.stale.get(id);
    if (!entry) {
      return false;
    }
    if (this.now() >= entry.until || this.now() < entry.until - TIMINGS.lateAnswerQuarantine) {
      this.stale.delete(id);
      return false;
    }
    entry.count -= 1;
    if (entry.count <= 0) {
      this.stale.delete(id);
    }
    return true;
  }

  /** A datagram: the answer of the request in flight, or dropped. */
  received(datagram, rinfo) {
    if (!Buffer.isBuffer(datagram) || datagram.length > LIMITS.datagramBytes) {
      this.dropped += 1;
      return;
    }
    const from = normalizeIp(rinfo?.address);
    const answer = classify(datagram.toString('latin1'));
    const key = keyOf(answer);
    const pending = this.pending;
    if (pending && from === pending.job.host && matches(pending.job.expect, answer)) {
      const unsure = this.consumeStale(from, key);
      pending.done(undefined, unsure ? { ...answer, unsure: true } : answer);
      return;
    }
    if (key) {
      // A late answer arriving while nothing waits for it: counted off.
      this.consumeStale(from, key);
    }
    this.dropped += 1;
  }

  /**
   * Releases the wait of the request in flight when `predicate(tag)` holds:
   * it was sent, it rejects as "maybe sent" (ABANDONED), its late answer is
   * expected. Returns whether a wait was released.
   */
  abandon(predicate) {
    const pending = this.pending;
    if (!pending || !predicate(pending.job.tag)) {
      return false;
    }
    pending.done(new ChannelError(ERROR_KINDS.ABANDONED, 'wait released'));
    return true;
  }

  /**
   * Sends `payload` to `host` and resolves with the answer it expects:
   * `{ kind: 'report', id, report, unsure? }` or `{ kind: 'tch-ok' | 'tch-err', unsure? }`.
   * `startBy`: the time after which it must not leave (LATE, unsent).
   * `answerBy`: the time after which the answer is no longer awaited (the
   * wait is the shorter of `timeoutMs` from the send and this).
   * `gapAfter`: a pause of this station after the message (ms).
   * `priority`: higher first among the requests ready to leave.
   * `beforeSend()`: last check right before sending; throwing cancels it.
   * `tag`: what `abandon` looks at.
   */
  request(
    host,
    payload,
    {
      expect,
      timeoutMs,
      startBy = Infinity,
      answerBy = Infinity,
      gapAfter = 0,
      priority = 0,
      beforeSend,
      tag,
    },
  ) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new ChannelError(ERROR_KINDS.CLOSED, 'channel closed'));
        return;
      }
      this.queue.push({
        host: normalizeIp(host),
        payload,
        expect,
        timeoutMs,
        startBy,
        answerBy,
        gapAfter,
        priority: Number(priority) || 0,
        beforeSend,
        tag,
        resolve,
        reject,
      });
      this.wake?.();
      this.pump();
    });
  }

  /** When a request may leave: the channel pause and its station's own pause. */
  readyTime(job) {
    return Math.max(this.readyAt, this.hostReadyAt.get(job.host) ?? 0);
  }

  /** The next request to send now: the highest priority among the ready ones, else undefined. */
  pick() {
    const now = this.now();
    let best;
    for (const job of this.queue) {
      if (this.readyTime(job) <= now && (!best || job.priority > best.priority)) {
        best = job;
      }
    }
    if (best) {
      this.queue.splice(this.queue.indexOf(best), 1);
    }
    return best;
  }

  /** The requests that can no longer leave in time: rejected unsent. */
  dropLate() {
    for (const job of [...this.queue]) {
      if (Math.max(this.now(), this.readyTime(job)) > job.startBy) {
        this.queue.splice(this.queue.indexOf(job), 1);
        job.reject(new ChannelError(ERROR_KINDS.LATE, 'too late to send'));
      }
    }
  }

  /** Waits `ms`, or less when a request arrives. */
  sleep(ms) {
    return new Promise((resolve) => {
      const handle = this.timers.setTimeout(finish, Math.max(1, ms));
      function finish() {
        resolve();
      }
      this.wake = () => {
        this.wake = undefined;
        this.timers.clearTimeout(handle);
        resolve();
      };
    }).finally(() => {
      this.wake = undefined;
    });
  }

  async pump() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0 && this.socket) {
        this.dropLate();
        const job = this.pick();
        if (!job) {
          if (this.queue.length === 0) break;
          const next = Math.min(...this.queue.map((j) => this.readyTime(j)));
          await this.sleep(next - this.now());
          continue;
        }
        try {
          job.resolve(await this.run(job));
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  run(job) {
    if (!this.socket) {
      return Promise.reject(new ChannelError(ERROR_KINDS.CLOSED, 'channel closed'));
    }
    if (this.now() > job.startBy) {
      return Promise.reject(new ChannelError(ERROR_KINDS.LATE, 'too late to send'));
    }
    try {
      job.beforeSend?.();
    } catch (err) {
      return Promise.reject(err);
    }
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const done = (err, answer) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        if (this.pending?.done === done) {
          this.pending = undefined;
        }
        if (err?.kind === ERROR_KINDS.TIMEOUT || err?.kind === ERROR_KINDS.ABANDONED) {
          this.addStale(job.host, expectKey(job.expect));
        }
        if (err) reject(err);
        else resolve(answer);
      };
      this.pending = { job, done };
      // The pauses run from the send, whatever the answer.
      this.readyAt = this.now() + TIMINGS.gap;
      if (job.gapAfter > 0) {
        this.hostReadyAt.set(job.host, this.now() + job.gapAfter);
      }
      timer = this.timers.setTimeout(
        () => done(new ChannelError(ERROR_KINDS.TIMEOUT, 'no answer')),
        Math.max(1, Math.min(job.timeoutMs, job.answerBy - this.now())),
      );
      try {
        socket.send(Buffer.from(job.payload, 'latin1'), UDP_PORT, job.host, (err) => {
          if (err) done(new ChannelError(ERROR_KINDS.SEND, `send: ${err.code ?? 'error'}`));
        });
      } catch (err) {
        done(new ChannelError(ERROR_KINDS.SEND, `send: ${err?.code ?? 'error'}`));
      }
    });
  }
}
