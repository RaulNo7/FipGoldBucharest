'use strict';

// A fake ATEM switcher on 127.0.0.1 (random UDP port) for the tests.
const dgram = require('dgram');
const A = require('../src/atem');

/** A fake ATEM Mini. opts.full = refuse the session (no free slots). */
function fakeAtem(opts = {}) {
  const sock = dgram.createSocket('udp4');
  const log = { commands: [], acksFromClient: [], resent: 0, program: 1 };
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
      const dump1 = pkt(A.FLAG.ACK_REQUEST, SESSION, 0, ++nextId,
        Buffer.concat([cmd('_pin', name), inPr(1, 'Court camera', 'CRT'), inPr(2, 'Interview', 'INT'), cmd('PrgI', prg)]));
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
      for (const c of A.decodeCommands(msg.subarray(12, length))) {
        log.commands.push({ name: c.name, me: c.data.readUInt8(0), input: c.data.readUInt16BE(2), session: msg.readUInt16BE(2), id });
        if (c.name === 'CPgI') log.program = c.data.readUInt16BE(2);
      }
      if (opts.dropFirstCommand && log.commands.length === 1) return; // client must resend
      send(pkt(A.FLAG.ACK, SESSION, id, 0), rinfo);
    }
  });
  return new Promise((resolve) => sock.bind(opts.port || 0, '127.0.0.1', () => resolve({ port: sock.address().port, log, close: () => sock.close() })));
}

module.exports = { fakeAtem };
