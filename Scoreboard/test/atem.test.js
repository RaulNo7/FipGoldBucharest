'use strict';

/* Tests for the ATEM client (src/atem.js) against a fake switcher on localhost
   that speaks the same UDP protocol: hello -> new session -> state dump (with
   packets resent until acked) -> InCm, then acks our commands. */

const A = require('../src/atem');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ FAIL: ' + msg);
  }
}

console.log('\nRunning ATEM client tests…\n');

const { fakeAtem } = require('./fake-atem');

(async () => {
  // ---- info ----
  let atem = await fakeAtem();
  const info = await A.atemInfo('127.0.0.1', { port: atem.port });
  assert(info.product === 'ATEM Mini', `product name read from _pin (got ${info.product})`);
  assert(info.programInput === 1, 'program input read from PrgI');
  assert(info.inputs[2] && info.inputs[2].long === 'Interview' && info.inputs[2].short === 'INT', 'input names read from InPr');
  await new Promise((r) => setTimeout(r, 100));
  assert(atem.log.acksFromClient.includes(1) && atem.log.acksFromClient.includes(2), `every state packet is acknowledged (acks: ${atem.log.acksFromClient})`);
  atem.close();

  // ---- cut to the interview camera ----
  atem = await fakeAtem();
  const r = await A.setProgramInput('127.0.0.1', 2, { port: atem.port });
  const cut = atem.log.commands.filter((c) => c.name === 'CPgI');
  assert(cut.length === 1 && cut[0].me === 0 && cut[0].input === 2, 'CPgI sent once for M/E 1, input 2');
  assert(cut[0].session === 0x8123, 'command uses the session id the switcher assigned');
  assert(r.before === 1 && r.after === 2 && atem.log.program === 2, 'reports the input that was on before');
  atem.close();

  // ---- already on that input: nothing sent ----
  atem = await fakeAtem();
  await A.setProgramInput('127.0.0.1', 1, { port: atem.port });
  assert(atem.log.commands.length === 0, 'no command when the input is already on program');
  atem.close();

  // ---- lost ack: the command is resent ----
  atem = await fakeAtem({ dropFirstCommand: true });
  await A.setProgramInput('127.0.0.1', 2, { port: atem.port });
  const sends = atem.log.commands.filter((c) => c.name === 'CPgI');
  assert(sends.length >= 2 && sends.every((c) => c.id === sends[0].id), 'unacknowledged command is resent with the same packet id');
  atem.close();

  // ---- refused session / nobody there ----
  atem = await fakeAtem({ full: true });
  const full = await A.atemInfo('127.0.0.1', { port: atem.port }).then(() => null, (e) => e.message);
  assert(/no free connection slots/.test(full || ''), `refused session reported (got ${full})`);
  atem.close();
  const t0 = Date.now();
  const none = await A.atemInfo('127.0.0.1', { port: 9, timeoutMs: 600 }).then(() => null, (e) => e.message);
  assert(/no answer from the ATEM|ECONNREFUSED/.test(none || '') && Date.now() - t0 < 2000, `unreachable ATEM fails fast (got ${none})`);

  // ---- find ----
  atem = await fakeAtem();
  const found = await A.findAtems('127.0.0', { port: atem.port, waitMs: 500 });
  assert(found.includes('127.0.0.1'), `findAtems sees the switcher (got ${found.join(', ')})`);
  atem.close();

  console.log(`${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
