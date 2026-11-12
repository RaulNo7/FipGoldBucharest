'use strict';
/**
 * Minimal Blackmagic ATEM client (UDP 9910), zero dependencies.
 *
 * Just enough of the switcher protocol for the Media tab's interview button:
 * open a session, read the initial state dump (product name, inputs, program
 * input), cut the program bus to another input, close. Every call opens its
 * own short session — the ATEM drops it by itself a few seconds after we stop
 * answering, so nothing has to stay connected between button presses.
 *
 * Packet = 12-byte header + commands.
 *   header: u16 (flags << 11 | length) · u16 session · u16 ack id · u16 0 · u16 0 · u16 packet id
 *   command: u16 length (incl. this 8-byte header) · u16 0 · 4-char name · data
 */
const dgram = require('dgram');

const ATEM_PORT = Number(process.env.ATEM_PORT) || 9910; // env override for the tests' fake switcher
const FLAG = { ACK_REQUEST: 0x01, HELLO: 0x02, RETRANSMIT: 0x04, RETRANSMIT_REQUEST: 0x08, ACK: 0x10 };
const HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0]);
const HELLO_ANSWER = Buffer.from([0x80, 0x0c, 0x53, 0xab, 0, 0, 0, 0, 0, 0x03, 0, 0]);

function packetHeader(flags, length, session, ackId, packetId) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(((flags << 11) | length) & 0xffff, 0);
  b.writeUInt16BE(session & 0xffff, 2);
  b.writeUInt16BE(ackId & 0xffff, 4);
  b.writeUInt16BE(packetId & 0xffff, 10);
  return b;
}

function encodeCommand(name, data) {
  const b = Buffer.alloc(8 + data.length);
  b.writeUInt16BE(8 + data.length, 0);
  b.write(name, 4, 4, 'ascii');
  data.copy(b, 8);
  return b;
}

function* decodeCommands(payload) {
  let off = 0;
  while (off + 8 <= payload.length) {
    const len = payload.readUInt16BE(off);
    if (len < 8 || off + len > payload.length) return;
    yield { name: payload.toString('ascii', off + 4, off + 8), data: payload.subarray(off + 8, off + len) };
    off += len;
  }
}

const cString = (buf, start, max) => {
  const s = buf.subarray(start, Math.min(buf.length, start + max));
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString('utf8').trim();
};

/**
 * Opens a session with the switcher at `host`, waits for its initial state, runs
 * `fn(session)` and closes. session.state = { product, programInput, inputs }.
 * session.send(name, dataBuffer) resolves once the ATEM acknowledged the command.
 */
function withAtem(host, fn, { timeoutMs = 4000, port = ATEM_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const state = { product: '', programInput: null, inputs: {} };
    const seen = new Set(); // remote packet ids already handled (the ATEM resends until acked)
    const waiting = new Map(); // our packet id -> { resolve, reject, timer }
    let session = 0x53ab;
    let localId = 0;
    let ready = false;
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      for (const w of waiting.values()) clearInterval(w.timer);
      waiting.clear();
      // close a moment later so the last acknowledgements still go out
      setTimeout(() => { try { sock.close(); } catch (_) { /* already closed */ } }, 50);
      if (err) reject(err);
      else resolve(value);
    };
    const connectTimer = setTimeout(
      () => finish(new Error(`no answer from the ATEM at ${host} - check the IP and the network cable`)),
      timeoutMs,
    );
    const out = (buf) => sock.send(buf, port, host, (err) => err && finish(new Error(`ATEM ${host}: ${err.message}`)));

    const sessionApi = {
      state,
      send(name, data) {
        localId = (localId + 1) & 0x7fff;
        const id = localId;
        const cmd = encodeCommand(name, data);
        const pkt = Buffer.concat([packetHeader(FLAG.ACK_REQUEST, 12 + cmd.length, session, 0, id), cmd]);
        return new Promise((res, rej) => {
          let tries = 0;
          const timer = setInterval(() => {
            if (++tries > 5) {
              clearInterval(timer);
              waiting.delete(id);
              rej(new Error(`the ATEM did not confirm ${name}`));
            } else out(pkt); // resend until acknowledged
          }, 300);
          waiting.set(id, { resolve: res, timer });
          out(pkt);
        });
      },
    };

    const apply = (name, data) => {
      if (name === '_pin' && data.length >= 4) state.product = cString(data, 0, 44);
      else if (name === 'PrgI' && data.length >= 4 && data.readUInt8(0) === 0) state.programInput = data.readUInt16BE(2);
      else if (name === 'InPr' && data.length >= 26) {
        state.inputs[data.readUInt16BE(0)] = { long: cString(data, 2, 20), short: cString(data, 22, 4) };
      } else if (name === 'InCm' && !ready) {
        ready = true;
        clearTimeout(connectTimer);
        Promise.resolve()
          .then(() => fn(sessionApi))
          .then((v) => finish(null, v), (e) => finish(e));
      }
    };

    sock.on('error', (err) => finish(new Error(`ATEM ${host}: ${err.message}`)));
    sock.on('message', (msg) => {
      if (msg.length < 12) return;
      const flags = msg.readUInt8(0) >> 3;
      const length = msg.readUInt16BE(0) & 0x07ff;
      if (flags & FLAG.HELLO) {
        if (msg.length > 12 && msg.readUInt8(12) === 0x03) {
          finish(new Error(`the ATEM at ${host} has no free connection slots`));
          return;
        }
        out(HELLO_ANSWER);
        return;
      }
      session = msg.readUInt16BE(2);
      const remoteId = msg.readUInt16BE(10);
      if (flags & FLAG.ACK) {
        const acked = msg.readUInt16BE(4);
        for (const [id, w] of waiting) {
          if (id <= acked) { clearInterval(w.timer); waiting.delete(id); w.resolve(); } // a session never wraps the 15-bit id
        }
      }
      if (flags & FLAG.ACK_REQUEST) {
        out(packetHeader(FLAG.ACK, 12, session, remoteId, 0));
        if (seen.has(remoteId)) return;
        seen.add(remoteId);
        if (length > 12) for (const c of decodeCommands(msg.subarray(12, length))) apply(c.name, c.data);
      }
    });

    out(HELLO);
  });
}

/** Product name, program input and input names (for the Admin tab's Test button). */
function atemInfo(host, opts) {
  return withAtem(host, async (s) => ({ ...s.state }), opts);
}

/** Cuts the program bus of mix effect 1 to `input` (1 = HDMI 1, ...). Returns the input that was on before. */
function setProgramInput(host, input, opts) {
  return withAtem(host, async (s) => {
    const before = s.state.programInput;
    if (before !== input) {
      const data = Buffer.alloc(4);
      data.writeUInt8(0, 0); // mix effect 1
      data.writeUInt16BE(input, 2);
      await s.send('CPgI', data);
    }
    return { before, after: input, product: s.state.product };
  }, opts);
}

/**
 * Looks for ATEMs on a /24 network ("192.168.88") by sending the opening packet
 * to every address and listening for the switcher's answer.
 */
function findAtems(prefix, { waitMs = 1500, port = ATEM_PORT } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = new Set();
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      if (msg.length >= 12 && (msg.readUInt8(0) >> 3) & FLAG.HELLO) found.add(rinfo.address);
    });
    sock.bind(() => {
      for (let i = 1; i <= 254; i++) sock.send(HELLO, port, `${prefix}.${i}`, () => {});
      setTimeout(() => {
        try { sock.close(); } catch (_) { /* closed */ }
        resolve([...found].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3])));
      }, waitMs);
    });
  });
}

module.exports = { withAtem, atemInfo, setProgramInput, findAtems, encodeCommand, decodeCommands, packetHeader, FLAG, ATEM_PORT };
