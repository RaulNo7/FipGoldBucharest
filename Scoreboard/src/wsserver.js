'use strict';

/**
 * Minimal zero-dependency WebSocket server (RFC 6455 subset).
 *
 * Supports exactly what this app needs: a text-message channel with broadcast,
 * ping/pong keep-alive, and clean close handling. No npm packages required.
 *
 * Usage:
 *   const hub = createWsHub();
 *   httpServer.on('upgrade', hub.handleUpgrade);
 *   hub.onMessage((client, text) => { ... });
 *   hub.broadcast(JSON.stringify(...));
 */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Build an unmasked server frame (server->client frames are never masked). */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

function createWsHub({ heartbeatMs = 30000 } = {}) {
  const clients = new Set();
  let messageHandler = null;
  let connectHandler = null;

  function send(socket, opcode, payload) {
    if (socket.writable) {
      try {
        socket.write(encodeFrame(opcode, payload));
      } catch (_) {
        /* socket gone */
      }
    }
  }

  function sendText(socket, text) {
    send(socket, OP_TEXT, text);
  }

  function broadcast(text) {
    const frame = encodeFrame(OP_TEXT, text);
    for (const c of clients) {
      if (c.writable) {
        try {
          c.write(frame);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function closeSocket(socket) {
    clients.delete(socket);
    try {
      socket.end();
    } catch (_) {
      /* ignore */
    }
  }

  function handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));

    socket.setNoDelay(true);
    socket.isAlive = true;
    clients.add(socket);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Parse as many complete frames as are buffered.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (buffer.length < 2) break;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buffer.length < offset + 2) break;
          len = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (buffer.length < offset + 8) break;
          // Skip high 32 bits (payloads are tiny here).
          len = buffer.readUInt32BE(offset + 4);
          offset += 8;
        }

        let maskKey;
        if (masked) {
          if (buffer.length < offset + 4) break;
          maskKey = buffer.slice(offset, offset + 4);
          offset += 4;
        }

        if (buffer.length < offset + len) break; // wait for the rest

        let payload = buffer.slice(offset, offset + len);
        if (masked) {
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
          payload = out;
        }
        buffer = buffer.slice(offset + len);

        switch (opcode) {
          case OP_TEXT:
          case OP_CONT:
            if (messageHandler) {
              try {
                messageHandler(socket, payload.toString('utf8'));
              } catch (err) {
                /* swallow handler errors so one bad message can't kill the socket */
              }
            }
            break;
          case OP_PING:
            send(socket, OP_PONG, payload);
            break;
          case OP_PONG:
            socket.isAlive = true;
            break;
          case OP_CLOSE:
            send(socket, OP_CLOSE, Buffer.alloc(0));
            closeSocket(socket);
            return;
          default:
            break;
        }
      }
    });

    socket.on('error', () => closeSocket(socket));
    socket.on('close', () => clients.delete(socket));

    if (connectHandler) connectHandler(socket);
  }

  // Keep-alive: ping clients; drop ones that never pong back.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.isAlive === false) {
        closeSocket(c);
        continue;
      }
      c.isAlive = false;
      send(c, OP_PING, Buffer.alloc(0));
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    handleUpgrade,
    broadcast,
    sendText,
    onMessage: (fn) => {
      messageHandler = fn;
    },
    onConnect: (fn) => {
      connectHandler = fn;
    },
    get size() {
      return clients.size;
    },
  };
}

module.exports = { createWsHub };
