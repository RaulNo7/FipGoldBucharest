'use strict';

const crypto = require('crypto');

/**
 * Minimal obs-websocket v5 client, using Node's built-in WebSocket client
 * (stable since Node 22) and only the handful of requests the commercial
 * break needs: GetVersion, SetCurrentProgramScene, GetMediaInputStatus.
 *
 * Protocol: server sends Hello (op 0, optionally with an auth challenge);
 * client answers Identify (op 1, auth = b64(sha256(b64(sha256(pw+salt)) + challenge)));
 * server confirms Identified (op 2); then requests are op 6 / responses op 7.
 */
class ObsClient {
  constructor() {
    this.ws = null;
    this.identified = false;
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    this.nextId = 1;
    this.lastError = null;
  }

  get connected() {
    return this.identified;
  }

  connect(url, password, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        const err = new Error('Node.js >= 22 is required for OBS control (built-in WebSocket client missing)');
        this.lastError = err.message;
        return reject(err);
      }

      this.close();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.lastError = err.message;
        this.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('OBS connection timed out')), timeoutMs);

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        return fail(err);
      }
      this.ws = ws;

      ws.addEventListener('error', () =>
        fail(new Error('OBS connection failed — is OBS running with the WebSocket server enabled?')));

      ws.addEventListener('close', () => {
        this.identified = false;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('OBS connection closed'));
        }
        this.pending.clear();
        if (!settled) fail(new Error('OBS closed the connection (wrong WebSocket password?)'));
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }

        if (msg.op === 0) {
          // Hello
          const d = msg.d || {};
          const identify = { op: 1, d: { rpcVersion: 1 } };
          if (d.authentication) {
            const { challenge, salt } = d.authentication;
            const secret = crypto.createHash('sha256').update((password || '') + salt).digest('base64');
            identify.d.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
          }
          ws.send(JSON.stringify(identify));
        } else if (msg.op === 2) {
          // Identified
          this.identified = true;
          this.lastError = null;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.op === 7) {
          // RequestResponse
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          clearTimeout(p.timer);
          const st = msg.d.requestStatus || {};
          if (st.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(`OBS request ${msg.d.requestType || ''} failed: ${st.comment || st.code}`));
        }
      });
    });
  }

  request(requestType, requestData, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.identified) {
        return reject(new Error('Not connected to OBS'));
      }
      const requestId = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS request ${requestType} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* already gone */
      }
    }
    this.ws = null;
    this.identified = false;
  }
}

module.exports = { ObsClient };
