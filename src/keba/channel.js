// -----------------------------------------------------------------------------
// The UDP channel to the stations: one socket bound to port 7090 (a station
// answers to port 7090 of the sender, whatever the source port, as
// keba-kecontact binds it), ONE request at a time for all the stations, and
// the pause the stations need between two messages (100 ms, 2 s after
// "ena 0", as keba-kecontact).
//
// An answer counts only for the request in flight, only from the IP address
// it was sent to, and only of the kind it expects (report 2 for "report 2",
// TCH-OK / TCH-ERR for a command). Anything else (another station, a push
// message, a late answer of an earlier request, a datagram over 4 KB) is
// dropped. Commands go before the reads waiting in the queue.
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
  /** Could not leave before its deadline: nothing sent. */
  LATE: 'late',
  /** The channel was closed: nothing sent. */
  CLOSED: 'closed',
};

export class ChannelError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ChannelError';
    this.kind = kind;
    /** Whether the datagram may have left. */
    this.maybeSent = kind === ERROR_KINDS.TIMEOUT;
  }
}

const normalizeIp = (address) =>
  String(address ?? '')
    .toLowerCase()
    .replace(/^::ffff:/, '');

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
    /** Queued requests: { host, payload, expect, timeoutMs, startBy, gapAfter, priority, resolve, reject }. */
    this.queue = [];
    this.running = false;
    /** The request waiting for its answer: { host, expect, done }. */
    this.pending = undefined;
    /** No message leaves before this time (the pause after the previous one). */
    this.readyAt = 0;
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

  close() {
    const socket = this.socket;
    this.socket = undefined;
    for (const job of this.queue.splice(0)) {
      job.reject(new ChannelError(ERROR_KINDS.CLOSED, 'channel closed'));
    }
    if (this.pending) {
      this.pending.done(new ChannelError(ERROR_KINDS.CLOSED, 'channel closed'));
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  /** A datagram: the answer of the request in flight, or dropped. */
  received(datagram, rinfo) {
    const pending = this.pending;
    if (!pending || !Buffer.isBuffer(datagram) || datagram.length > LIMITS.datagramBytes) {
      this.dropped += 1;
      return;
    }
    if (normalizeIp(rinfo?.address) !== pending.host) {
      this.dropped += 1;
      return;
    }
    const answer = classify(datagram.toString('latin1'));
    if (!matches(pending.expect, answer)) {
      this.dropped += 1;
      return;
    }
    pending.done(undefined, answer);
  }

  /**
   * Sends `payload` to `host` and resolves with the answer it expects:
   * `{ kind: 'report', id, report }` or `{ kind: 'tch-ok' | 'tch-err' }`.
   * `startBy`: the time after which it must not leave (LATE, unsent).
   * `answerBy`: the time after which the answer is no longer awaited (the
   * wait is the shorter of `timeoutMs` from the send and this).
   * `priority`: before the queued requests without it.
   */
  request(
    host,
    payload,
    { expect, timeoutMs, startBy = Infinity, answerBy = Infinity, gapAfter = 0, priority = false },
  ) {
    return new Promise((resolve, reject) => {
      const job = {
        host: normalizeIp(host),
        payload,
        expect,
        timeoutMs,
        startBy,
        answerBy,
        gapAfter,
        priority,
        resolve,
        reject,
      };
      if (priority) {
        const index = this.queue.findIndex((j) => !j.priority);
        this.queue.splice(index === -1 ? this.queue.length : index, 0, job);
      } else {
        this.queue.push(job);
      }
      this.pump();
    });
  }

  async pump() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
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

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  async run(job) {
    const wait = this.readyAt - this.now();
    if (this.now() + Math.max(0, wait) > job.startBy) {
      throw new ChannelError(ERROR_KINDS.LATE, 'too late to send');
    }
    if (wait > 0) {
      await this.sleep(wait);
    }
    if (!this.socket) {
      throw new ChannelError(ERROR_KINDS.CLOSED, 'channel closed');
    }
    if (this.now() > job.startBy) {
      throw new ChannelError(ERROR_KINDS.LATE, 'too late to send');
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
        if (err) reject(err);
        else resolve(answer);
      };
      this.pending = { host: job.host, expect: job.expect, done };
      // The pause runs from the send, whatever the answer.
      this.readyAt = this.now() + Math.max(TIMINGS.gap, job.gapAfter);
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
