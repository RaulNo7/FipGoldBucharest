'use strict';
/**
 * Minimal Blackmagic ATEM client (UDP 9910), zero dependencies.
 *
 * Just enough of the switcher protocol for the Media tab's interview button:
 * open a session, read the initial state dump (product name, inputs, program
 * input, upstream keyer 1, transition settings), take the program bus to another
 * input (cut, crossfade, wipe or push) and put the keyer's picture-in-picture box
 * on or off air (flying in / out with a push), close. Every call opens its
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
    // keyer = upstream key 1 of M/E 1; transition = { style, selection } of M/E 1; fps from the video mode
    // raw = the ATEM's own transition settings (mix, wipe, DVE, colour 2), put back after our transition
    const state = { product: '', programInput: null, inputs: {}, keyer: {}, transition: {}, fps: 25, raw: {} };
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
      /** send(name, data) or send([[name, data], ...]): several commands go in one packet, applied together. */
      send(name, data) {
        localId = (localId + 1) & 0x7fff;
        const id = localId;
        const list = Array.isArray(name) ? name : [[name, data]];
        const cmd = Buffer.concat(list.map(([n, d]) => encodeCommand(n, d)));
        name = list.map(([n]) => n).join('+');
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
      state.last = state.last || {};
      state.last[name] = data; // the latest of every state command (for diagnostics)
      if (name === '_pin' && data.length >= 4) state.product = cString(data, 0, 44);
      else if (name === 'PrgI' && data.length >= 4 && data.readUInt8(0) === 0) state.programInput = data.readUInt16BE(2);
      else if (name === 'VidM' && data.length >= 1) state.fps = VIDEO_FPS[data.readUInt8(0)] || 25;
      else if (name === 'TrSS' && data.length >= 3 && data.readUInt8(0) === 0) {
        state.transition = { style: data.readUInt8(1), selection: data.readUInt8(2) };
      } else if (name === 'TrPs' && data.length >= 2 && data.readUInt8(0) === 0) state.inTransition = data.readUInt8(1) === 1;
      else if ((name === 'TMxP' || name === 'TWpP' || name === 'TDvP') && data.length >= 4 && data.readUInt8(0) === 0) state.raw[name] = Buffer.from(data);
      else if (name === 'ColV' && data.length >= 8 && data.readUInt8(0) === 1) state.raw.ColV2 = Buffer.from(data);
      else if (name === 'KeOn' && data.length >= 3 && data.readUInt8(0) === 0 && data.readUInt8(1) === 0) state.keyer.onAir = data.readUInt8(2) === 1;
      else if (name === 'KeBP' && data.length >= 8 && data.readUInt8(0) === 0 && data.readUInt8(1) === 0) {
        state.keyer.type = data.readUInt8(2); // 0 luma, 1 chroma, 2 pattern, 3 DVE (picture-in-picture)
        state.keyer.fill = data.readUInt16BE(6);
      } else if (name === 'KeDV' && data.length >= 20 && data.readUInt8(0) === 0 && data.readUInt8(1) === 0) {
        state.keyer.box = { sizeX: data.readUInt32BE(4), sizeY: data.readUInt32BE(8), x: data.readInt32BE(12), y: data.readInt32BE(16) };
        if (data.length >= 57) state.keyer.rate = data.readUInt8(56); // frames the box takes to fly between key frames
      } else if (name === 'InPr' && data.length >= 26) {
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
 * The picture-in-picture box in ATEM units for a 1920x1080 frame: size in
 * thousandths (1000 = full frame), position of the box centre in thousandths of
 * the ATEM grid (x -16..16, y -9..9, 0 = middle, so 60 px per unit).
 * sizePct = % of the frame width; left / bottom = px of the box's left and bottom edge.
 */
function pipBox(sizePct, { left = 40, bottom = 996 } = {}) {
  const size = Math.min(50, Math.max(10, Math.round(Number(sizePct) || 25))) / 100;
  const w = 1920 * size;
  const h = 1080 * size;
  const cx = left + w / 2;
  const cy = bottom - h / 2;
  return {
    sizeX: Math.round(size * 1000),
    sizeY: Math.round(size * 1000),
    x: Math.round(((cx - 960) / 60) * 1000),
    y: Math.round(((540 - cy) / 60) * 1000),
  };
}

// frames per second of the ATEM video modes (VidM): 525i59.94, 625i50, (16:9 versions), 720p50, 720p59.94,
// 1080i50, 1080i59.94, 1080p23.98, 1080p24, 1080p25, 1080p29.97, 1080p50, 1080p59.94
const VIDEO_FPS = [30, 25, 30, 25, 50, 60, 25, 30, 24, 24, 25, 30, 50, 60];
const STYLE = { mix: 0, dip: 1, wipe: 2, dve: 3, sting: 4 };
const WIPE_DIAGONAL = 16; // wipe pattern: diagonal from the top left corner
const DVE_PUSH = 28; // DVE transition effect 'push right': the new picture comes in from the left, pushing the old one out (reverse = the other way)
const GOLD = { hue: 470, sat: 1000, luma: 700 }; // colour generator 2 for the wipe's line (FRP gold #fcd116)
const SELECT_BACKGROUND = 1;
const SELECT_KEY1 = 2;

const keyerData = (bytes) => {
  const d = Buffer.alloc(bytes);
  d.writeUInt8(0, 0); // M/E 1
  d.writeUInt8(0, 1); // upstream key 1
  return d;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u8 = (b, i) => (b && b.length > i ? b.readUInt8(i) : 0);
const u16 = (b, i) => (b && b.length > i + 1 ? b.readUInt16BE(i) : 0);

/** The picture-in-picture box moved just past the left edge of the frame (where it flies in from). */
function offLeft(box) {
  return { ...box, x: -16000 - Math.round(box.sizeX * 16) - 600 };
}

/** Stores the box's current size / position as fly key frame `id` (1 = A, 2 = B), like "Set A / Set B" on the ATEM. */
function storeKeyFrame(id) {
  const d = Buffer.alloc(4);
  d.writeUInt8(0, 0); // M/E 1
  d.writeUInt8(0, 1); // key 1
  d.writeUInt8(id, 2);
  return ['SFKF', d];
}

/** Waits until the ATEM reports the transition over and `program` on air (it reports ~0.3 s after the nominal length). */
async function transitionDone(s, program, transitionMs) {
  await sleep(transitionMs);
  const until = Date.now() + 2500;
  while (Date.now() < until && (s.state.inTransition || s.state.programInput !== program)) await sleep(40);
  await sleep(80);
}

function boxNow(box) {
  const dv = Buffer.alloc(64);
  dv.writeUInt32BE(0x0f, 0); // mask: sizeX, sizeY, positionX, positionY
  dv.writeUInt32BE(box.sizeX, 8);
  dv.writeUInt32BE(box.sizeY, 12);
  dv.writeInt32BE(box.x, 16);
  dv.writeInt32BE(box.y, 20);
  return ['CKDV', dv];
}

function runTo(frame) {
  const d = Buffer.alloc(8);
  d.writeUInt8(0, 1); // M/E 1
  d.writeUInt8(0, 2); // key 1
  d.writeUInt8(frame, 4); // 1 = key frame A, 2 = key frame B
  return ['RFlK', d];
}

function keyOn(on) {
  const d = keyerData(4);
  d.writeUInt8(on ? 1 : 0, 2);
  return ['CKOn', d];
}

function preview(input) {
  const d = Buffer.alloc(4);
  d.writeUInt16BE(input, 2);
  return ['CPvI', d];
}

function transitionStyle(style, selection) {
  const d = Buffer.alloc(4);
  d.writeUInt8(3, 0); // mask: style + selection
  d.writeUInt8(style, 2);
  d.writeUInt8(selection, 3);
  return ['CTTp', d];
}

/** The commands that set our transition's own settings, and the ones that put the ATEM's back. */
function transitionSettings(kind, frames, reverse, raw) {
  const set = [];
  const back = [];
  if (kind === 'mix') {
    const d = Buffer.alloc(4);
    d.writeUInt8(frames, 1);
    set.push(['CTMx', d]);
    if (raw.TMxP) {
      const b = Buffer.alloc(4);
      b.writeUInt8(u8(raw.TMxP, 1), 1);
      back.push(['CTMx', b]);
    }
  } else if (kind === 'wipe') {
    const c = Buffer.alloc(8);
    c.writeUInt8(7, 0); // mask: hue, saturation, luma
    c.writeUInt8(1, 1); // colour generator 2
    c.writeUInt16BE(GOLD.hue, 2);
    c.writeUInt16BE(GOLD.sat, 4);
    c.writeUInt16BE(GOLD.luma, 6);
    set.push(['CClV', c]);
    const w = Buffer.alloc(20);
    w.writeUInt16BE(0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x100 | 0x200, 0); // rate, pattern, border width + input, symmetry, softness, reverse, flip flop
    w.writeUInt8(frames, 3);
    w.writeUInt8(WIPE_DIAGONAL, 4);
    w.writeUInt16BE(300, 6); // a thin line
    w.writeUInt16BE(2002, 8); // ... in colour generator 2 (gold)
    w.writeUInt16BE(5000, 10);
    w.writeUInt16BE(0, 12); // sharp edge
    w.writeUInt8(reverse ? 1 : 0, 18);
    set.push(['CTWp', w]);
    if (raw.TWpP) {
      const r = raw.TWpP;
      const b = Buffer.alloc(20);
      b.writeUInt16BE(0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200, 0);
      b.writeUInt8(u8(r, 1), 3);
      b.writeUInt8(u8(r, 2), 4);
      b.writeUInt16BE(u16(r, 4), 6);
      b.writeUInt16BE(u16(r, 6), 8);
      b.writeUInt16BE(u16(r, 8), 10);
      b.writeUInt16BE(u16(r, 10), 12);
      b.writeUInt16BE(u16(r, 12), 14);
      b.writeUInt16BE(u16(r, 14), 16);
      b.writeUInt8(u8(r, 16), 18);
      b.writeUInt8(u8(r, 17), 19);
      back.push(['CTWp', b]);
    }
    if (raw.ColV2) {
      const b = Buffer.alloc(8);
      b.writeUInt8(7, 0);
      b.writeUInt8(1, 1);
      b.writeUInt16BE(u16(raw.ColV2, 2), 2);
      b.writeUInt16BE(u16(raw.ColV2, 4), 4);
      b.writeUInt16BE(u16(raw.ColV2, 6), 6);
      back.push(['CClV', b]);
    }
  } else if (kind === 'push') {
    const d = Buffer.alloc(20);
    d.writeUInt16BE(0x1 | 0x4 | 0x400 | 0x800, 0); // rate, style, reverse, flip flop
    d.writeUInt8(frames, 3);
    d.writeUInt8(DVE_PUSH, 5);
    d.writeUInt8(reverse ? 1 : 0, 17);
    set.push(['CTDv', d]);
    if (raw.TDvP) {
      const r = raw.TDvP;
      const b = Buffer.alloc(20);
      b.writeUInt16BE(0x1 | 0x4 | 0x400 | 0x800, 0);
      b.writeUInt8(u8(r, 1), 3);
      b.writeUInt8(u8(r, 3), 5);
      b.writeUInt8(u8(r, 15), 17);
      b.writeUInt8(u8(r, 16), 18);
      back.push(['CTDv', b]);
    }
  }
  return { set, back };
}

/**
 * One step of the interview button: take the program bus to `program` and
 *   pip = { on: true, fill, box }  -> upstream key 1 as a DVE box showing input `fill`, on air
 *   pip = { on: false }            -> the box off air
 *   pip = null                     -> the keyer is left alone
 * transition = { kind, seconds, reverse } (reverse = right to left, for going back):
 *   'mix'  crossfade; 'wipe' sharp diagonal wipe with a gold line; the box comes / goes with them
 *   'push' the new camera pushes the old one out; the box flies in from the left afterwards
 *          (flies out first when going back: the ATEM Mini has one DVE for both)
 *   null   a cut (camera + box in the same packet, the cut first)
 * beforeCut: async hook run once the session is open, right before a cut (the OBS overlay
 *   transitions cover the frame meanwhile).
 * The ATEM's own transition settings are put back once it is over (its AUTO button keeps working as before).
 * Returns { before, after, product, keyerWasOnAir }.
 */
function switchCameras(host, { program, pip = null, transition = null, beforeCut = null }, opts) {
  return withAtem(host, async (s) => {
    const st = s.state;
    const before = { programInput: st.programInput, keyerOnAir: !!st.keyer.onAir, transition: { ...st.transition } };
    const changeProgram = !!program && st.programInput !== program;
    const changeKey = !!pip && pip.on !== !!st.keyer.onAir;
    const kind = transition && changeProgram && !st.inTransition && ['mix', 'wipe', 'push'].includes(transition.kind) ? transition.kind : null;
    const frames = Math.min(250, Math.max(1, Math.round((Number(transition && transition.seconds) || 1) * st.fps)));
    const transitionMs = Math.round((frames / st.fps) * 1000);
    const flyMs = Math.round(((st.keyer.rate || 25) / st.fps) * 1000);
    const reverse = !!(transition && transition.reverse);

    // the box: DVE key showing the court camera, sized and placed (off air until its turn)
    const prepareBox = [];
    if (pip && pip.on) {
      if (st.keyer.type !== 3) {
        const tp = Buffer.alloc(8);
        tp.writeUInt8(1, 0); // mask: key type
        tp.writeUInt8(3, 3); // DVE
        prepareBox.push(['CKTp', tp]);
      }
      const fill = keyerData(4);
      fill.writeUInt16BE(pip.fill, 2);
      prepareBox.push(['CKeF', fill]);
      if (pip.box) {
        // push: A = just off the left edge, B = its place; parked at A until it flies in
        if (kind === 'push') prepareBox.push(boxNow(offLeft(pip.box)), storeKeyFrame(1), boxNow(pip.box), storeKeyFrame(2), boxNow(offLeft(pip.box)));
        else prepareBox.push(boxNow(pip.box));
      }
    }
    const restoreStyle = () =>
      before.transition.style !== undefined
        ? s.send([transitionStyle(before.transition.style, before.transition.selection || SELECT_BACKGROUND), ...settings.back])
        : settings.back.length ? s.send(settings.back) : null;
    const settings = kind ? transitionSettings(kind, frames, reverse, st.raw) : { set: [], back: [] };

    if (kind === 'mix' || kind === 'wipe') {
      // the box rides along in the same transition
      await s.send([...prepareBox, preview(program), transitionStyle(kind === 'mix' ? STYLE.mix : STYLE.wipe, SELECT_BACKGROUND | (changeKey ? SELECT_KEY1 : 0)),
        ...settings.set, ['DAut', Buffer.alloc(4)]]);
      await transitionDone(s, program, transitionMs);
      await restoreStyle();
    } else if (kind === 'push') {
      if (changeKey && !pip.on) {
        // going back: the box flies out to the left first (to key frame A, if set), then goes off air (it frees the DVE)
        const fs = st.last && st.last.KeFS;
        if (fs && fs.length >= 3 && fs.readUInt8(2) === 1) {
          await s.send([runTo(1)]);
          await sleep(flyMs + 350);
        }
        await s.send([keyOn(false)]);
      }
      await s.send([...prepareBox, preview(program), transitionStyle(STYLE.dve, SELECT_BACKGROUND), ...settings.set, ['DAut', Buffer.alloc(4)]]);
      await transitionDone(s, program, transitionMs);
      await restoreStyle();
      if (changeKey && pip.on) {
        // the box flies in from the left to its place
        await s.send([keyOn(true), runTo(2)]);
        await sleep(flyMs + 350);
      }
    } else {
      if (beforeCut) await beforeCut();
      // cut first, then the box: the court camera never shows small over itself
      const cmds = [...prepareBox];
      if (changeProgram) {
        const pg = Buffer.alloc(4);
        pg.writeUInt16BE(program, 2);
        cmds.push(['CPgI', pg]);
      }
      if (changeKey) cmds.push(keyOn(pip.on));
      if (cmds.length) await s.send(cmds);
    }
    return { before: before.programInput, after: program || before.programInput, product: st.product, keyerWasOnAir: before.keyerOnAir };
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
      const probe = () => {
        for (let i = 1; i <= 254; i++) sock.send(HELLO, port, `${prefix}.${i}`, () => {});
      };
      // Twice: Windows may drop the first packet to a host it has not resolved on the LAN yet (ARP).
      probe();
      setTimeout(probe, 400);
      setTimeout(() => {
        try { sock.close(); } catch (_) { /* closed */ }
        resolve([...found].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3])));
      }, waitMs);
    });
  });
}

module.exports = { withAtem, atemInfo, setProgramInput, switchCameras, pipBox, findAtems, encodeCommand, decodeCommands, packetHeader, FLAG, ATEM_PORT };
