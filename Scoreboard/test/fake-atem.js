'use strict';

// A fake ATEM switcher on 127.0.0.1 (random UDP port) for the tests.
const dgram = require('dgram');
const A = require('../src/atem');

/** A fake ATEM Mini. opts.full = refuse the session (no free slots); opts.keyType = upstream key 1's type (default 3, DVE). */
function fakeAtem(opts = {}) {
  const sock = dgram.createSocket('udp4');
  const log = { commands: [], packets: [], acksFromClient: [], resent: 0, program: 1, preview: 2, transition: { style: 0, selection: 1 }, mixRate: 30, wipe: { rate: 25, pattern: 0, borderInput: 2001, softness: 8300, reverse: false },
    dve: { rate: 25, style: 20, reverse: false }, color2: { hue: 270, sat: 1000, luma: 500 }, wipes: [], flights: [], keyFrames: {}, keyer: { onAir: false, type: opts.keyType === undefined ? 3 : opts.keyType, fill: 1, box: { sizeX: 200, sizeY: 200, x: -12500, y: -7000 } } };
  const SESSION = 0x8123;
  let nextId = 0;
  let unacked = new Map();
  const cmd = (name, data) => A.encodeCommand(name, data);
  const pkt = (flags, session, ackId, packetId, payload = Buffer.alloc(0)) =>
    Buffer.concat([A.packetHeader(flags, 12 + payload.length, session, ackId, packetId), payload]);
  const send = (buf, rinfo) => sock.send(buf, rinfo.port, rinfo.address);

  sock.on('message', (msg, rinfo) => {
    const flags = msg.readUInt8(0) >> 3;
    const length = msg.readUInt16BE(0) & 0x07ff;
    if (flags & A.FLAG.HELLO) {
      const reply = Buffer.alloc(8);
      reply.writeUInt8(opts.full ? 0x03 : 0x02, 0);
      send(pkt(A.FLAG.HELLO, 0x53ab, 0, 0, reply), rinfo);
      return;
    }
    if ((flags & A.FLAG.ACK) && msg.readUInt16BE(2) === 0x53ab) {
      // the client's hello answer: send the state dump in two reliable packets
      const name = Buffer.alloc(44);
      name.write('ATEM Mini', 0);
      const inPr = (id, long, short) => {
        const d = Buffer.alloc(36);
        d.writeUInt16BE(id, 0);
        d.write(long, 2);
        d.write(short, 22);
        return cmd('InPr', d);
      };
      const prg = Buffer.alloc(4);
      prg.writeUInt16BE(log.program, 2);
      const keOn = Buffer.alloc(4);
      keOn.writeUInt8(log.keyer.onAir ? 1 : 0, 2);
      const keBP = Buffer.alloc(20);
      keBP.writeUInt8(log.keyer.type, 2);
      keBP.writeUInt16BE(log.keyer.fill, 6);
      const keDV = Buffer.alloc(60);
      keDV.writeUInt8(25, 56); // the box flies between key frames in 25 frames
      keDV.writeUInt32BE(log.keyer.box.sizeX, 4);
      keDV.writeUInt32BE(log.keyer.box.sizeY, 8);
      keDV.writeInt32BE(log.keyer.box.x, 12);
      keDV.writeInt32BE(log.keyer.box.y, 16);
      const vidM = Buffer.alloc(4);
      vidM.writeUInt8(12, 0); // 1080p50
      const trSS = Buffer.alloc(8);
      trSS.writeUInt8(log.transition.style, 1);
      trSS.writeUInt8(log.transition.selection, 2);
      const tMxP = Buffer.alloc(4);
      tMxP.writeUInt8(log.mixRate, 1);
      const tWpP = Buffer.alloc(20);
      tWpP.writeUInt8(log.wipe.rate, 1);
      tWpP.writeUInt8(log.wipe.pattern, 2);
      tWpP.writeUInt16BE(log.wipe.borderInput, 6);
      tWpP.writeUInt16BE(5000, 8);
      tWpP.writeUInt16BE(log.wipe.softness, 10);
      tWpP.writeUInt8(log.wipe.reverse ? 1 : 0, 16);
      const tDvP = Buffer.alloc(20);
      tDvP.writeUInt8(log.dve.rate, 1);
      tDvP.writeUInt8(log.dve.style, 3);
      tDvP.writeUInt8(log.dve.reverse ? 1 : 0, 15);
      const colV = Buffer.alloc(8);
      colV.writeUInt8(1, 0);
      colV.writeUInt16BE(log.color2.hue, 2);
      colV.writeUInt16BE(log.color2.sat, 4);
      colV.writeUInt16BE(log.color2.luma, 6);
      const keFS = Buffer.alloc(8);
      keFS.writeUInt8(log.keyFrames[1] ? 1 : 0, 2);
      keFS.writeUInt8(log.keyFrames[2] ? 1 : 0, 3);
      const dump1 = pkt(A.FLAG.ACK_REQUEST, SESSION, 0, ++nextId,
        Buffer.concat([cmd('_pin', name), cmd('VidM', vidM), inPr(1, 'Court camera', 'CRT'), inPr(2, 'Interview', 'INT'), cmd('PrgI', prg),
          cmd('TrSS', trSS), cmd('TMxP', tMxP), cmd('TWpP', tWpP), cmd('TDvP', tDvP), cmd('ColV', colV),
          cmd('KeOn', keOn), cmd('KeBP', keBP), cmd('KeDV', keDV), cmd('KeFS', keFS)]));
      const dump2 = pkt(A.FLAG.ACK_REQUEST, SESSION, 0, ++nextId, cmd('InCm', Buffer.alloc(4)));
      unacked.set(1, dump1);
      unacked.set(2, dump2);
      send(dump1, rinfo);
      send(dump1, rinfo); // a duplicate, as after a lost ack
      setTimeout(() => send(dump2, rinfo), 20);
      return;
    }
    if (flags & A.FLAG.ACK) {
      log.acksFromClient.push(msg.readUInt16BE(4));
      unacked.delete(msg.readUInt16BE(4));
    }
    if (flags & A.FLAG.ACK_REQUEST) {
      const id = msg.readUInt16BE(10);
      const names = [];
      for (const c of A.decodeCommands(msg.subarray(12, length))) {
        names.push(c.name);
        log.commands.push({ name: c.name, me: c.data.readUInt8(0), input: c.data.readUInt16BE(2), data: Buffer.from(c.data), session: msg.readUInt16BE(2), id });
        if (c.name === 'CPgI') log.program = c.data.readUInt16BE(2);
        if (c.name === 'CKOn') log.keyer.onAir = c.data.readUInt8(2) === 1;
        if (c.name === 'CPvI') log.preview = c.data.readUInt16BE(2);
        if (c.name === 'CTTp') {
          if (c.data.readUInt8(0) & 1) log.transition.style = c.data.readUInt8(2);
          if (c.data.readUInt8(0) & 2) log.transition.selection = c.data.readUInt8(3);
        }
        if (c.name === 'CTWp') {
          const m = c.data.readUInt16BE(0);
          if (m & 0x1) log.wipe.rate = c.data.readUInt8(3);
          if (m & 0x2) log.wipe.pattern = c.data.readUInt8(4);
          if (m & 0x8) log.wipe.borderInput = c.data.readUInt16BE(8);
          if (m & 0x20) log.wipe.softness = c.data.readUInt16BE(12);
          if (m & 0x100) log.wipe.reverse = c.data.readUInt8(18) === 1;
        }
        if (c.name === 'CTMx') log.mixRate = c.data.readUInt8(1);
        if (c.name === 'CTDv') {
          const m = c.data.readUInt16BE(0);
          if (m & 0x1) log.dve.rate = c.data.readUInt8(3);
          if (m & 0x4) log.dve.style = c.data.readUInt8(5);
          if (m & 0x400) log.dve.reverse = c.data.readUInt8(17) === 1;
        }
        if (c.name === 'CClV' && c.data.readUInt8(1) === 1) {
          log.color2 = { hue: c.data.readUInt16BE(2), sat: c.data.readUInt16BE(4), luma: c.data.readUInt16BE(6) };
        }
        if (c.name === 'SFKF') log.keyFrames[c.data.readUInt8(2)] = { ...log.keyer.box };
        if (c.name === 'RFlK') {
          const k = c.data.readUInt8(4);
          log.flights.push({ to: k, onAir: log.keyer.onAir });
          if (log.keyFrames[k]) log.keyer.box = { ...log.keyFrames[k] };
        }
        if (c.name === 'DAut') {
          // the auto transition: preview and program swap; a key in the selection flips on / off air
          const kindNow = ['mix', 'dip', 'wipe', 'dve'][log.transition.style];
          const rate = kindNow === 'mix' ? log.mixRate : kindNow === 'wipe' ? log.wipe.rate : log.dve.rate;
          const reverse = kindNow === 'wipe' ? log.wipe.reverse : log.dve.reverse;
          log.wipes.push({ kind: kindNow, style: log.transition.style, selection: log.transition.selection, rate, reverse,
            pattern: log.wipe.pattern, dveStyle: log.dve.style, keyOnAirBefore: log.keyer.onAir });
          [log.program, log.preview] = [log.preview, log.program];
          if (log.transition.selection & 2) log.keyer.onAir = !log.keyer.onAir;
          // tell the client it is over (as the ATEM does with PrgI / TrPs)
          const prgNow = Buffer.alloc(4);
          prgNow.writeUInt16BE(log.program, 2);
          const upd = pkt(A.FLAG.ACK_REQUEST, SESSION, 0, ++nextId, Buffer.concat([cmd('PrgI', prgNow), cmd('TrPs', Buffer.alloc(8))]));
          setTimeout(() => send(upd, rinfo), 30);
        }
        if (c.name === 'CKeF') log.keyer.fill = c.data.readUInt16BE(2);
        if (c.name === 'CKTp' && (c.data.readUInt8(0) & 1)) log.keyer.type = c.data.readUInt8(3);
        if (c.name === 'CKDV') {
          const m = c.data.readUInt32BE(0);
          if (m & 1) log.keyer.box.sizeX = c.data.readUInt32BE(8);
          if (m & 2) log.keyer.box.sizeY = c.data.readUInt32BE(12);
          if (m & 4) log.keyer.box.x = c.data.readInt32BE(16);
          if (m & 8) log.keyer.box.y = c.data.readInt32BE(20);
        }
      }
      if (names.length && !log.packets.includes(id + ':' + names.join('+'))) log.packets.push(id + ':' + names.join('+'));
      if (opts.dropFirstCommand && log.commands.length === 1) return; // client must resend
      send(pkt(A.FLAG.ACK, SESSION, id, 0), rinfo);
    }
  });
  return new Promise((resolve) => sock.bind(opts.port || 0, '127.0.0.1', () => resolve({ port: sock.address().port, log, close: () => sock.close() })));
}

module.exports = { fakeAtem };
