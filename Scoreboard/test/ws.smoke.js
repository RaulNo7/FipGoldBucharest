'use strict';
// Smoke test for the custom WebSocket server using Node's built-in WebSocket client.
const PORT = process.env.PORT || 8090;
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let got = 0;

const timer = setTimeout(() => {
  console.error('TIMEOUT: did not complete handshake/round-trip');
  process.exit(1);
}, 5000);

ws.addEventListener('open', () => console.log('open: handshake OK'));

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  got++;
  if (got === 1) {
    console.log(`initial state received: points=${msg.state.points}, clients=${msg.clients}`);
    // Send a point for team 1 and expect an echoed state update.
    ws.send(JSON.stringify({ type: 'point', team: 1 }));
  } else if (got === 2) {
    console.log(`update received: points=${msg.state.points}`);
    if (msg.state.points[1] >= 1) {
      console.log('ROUND-TRIP OK: command applied and broadcast back');
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    } else {
      console.error('FAIL: point not reflected');
      process.exit(1);
    }
  }
});

ws.addEventListener('error', (e) => {
  console.error('WS ERROR', e.message || e);
  process.exit(1);
});
