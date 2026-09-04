/* Shared WebSocket client with auto-reconnect, used by both overlay and admin. */
(function (global) {
  'use strict';

  function connect({ onState, onStatus }) {
    let ws = null;
    let reconnectTimer = null;
    let closed = false;

    // Through the public (internet) port a referee key in the page URL
    // (?key=...) unlocks commands; it is forwarded to the socket and the REST
    // fallback. On the LAN port there is no key and none is needed.
    const key = new URLSearchParams(location.search).get('key');
    const keyQuery = key ? '?key=' + encodeURIComponent(key) : '';

    const wsUrl = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws${keyQuery}`;
    };

    function open() {
      ws = new WebSocket(wsUrl());

      ws.addEventListener('open', () => {
        if (onStatus) onStatus('connected');
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (msg.type === 'state' && onState) onState(msg.state, msg);
      });

      ws.addEventListener('close', () => {
        if (onStatus) onStatus('disconnected');
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      });
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, 1000);
    }

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      // Fallback to REST so commands still land if the socket is mid-reconnect.
      fetch('/api/command' + keyQuery, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
      }).catch(() => {});
      return false;
    }

    open();

    return {
      send,
      close() {
        closed = true;
        if (ws) ws.close();
      },
    };
  }

  global.PadelClient = { connect };
})(window);
