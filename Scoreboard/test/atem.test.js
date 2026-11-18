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

  // ---- keyer state is read ----
  atem = await fakeAtem();
  const kinfo = await A.atemInfo('127.0.0.1', { port: atem.port });
  assert(kinfo.keyer.type === 3 && kinfo.keyer.fill === 1 && kinfo.keyer.onAir === false && kinfo.keyer.box.x === -12500 && kinfo.keyer.box.y === -7000,
    'upstream key 1 read from KeBP / KeOn / KeDV (' + JSON.stringify(kinfo.keyer) + ')');
  atem.close();

  // ---- picture-in-picture box: size and position on a 1920x1080 frame ----
  const box = A.pipBox(25);
  assert(box.sizeX === 250 && box.sizeY === 250, 'pipBox: 25% = size 250');
  // left edge = centre - half width: 960 + x/1000*60 - 240 = 40 px; bottom edge = 540 - y/1000*60 + 135 = 996 px
  assert(Math.abs(960 + (box.x / 1000) * 60 - 240 - 40) < 1 && Math.abs(540 - (box.y / 1000) * 60 + 135 - 996) < 1, 'pipBox: 40 px from the left, bottom edge at 996 px (above the info bar)');
  assert(A.pipBox(99).sizeX === 500 && A.pipBox('x').sizeX === 250, 'pipBox: size clamped to 10-50%, default 25%');
  const packets = (a) => a.log.packets.map((p) => p.split(':')[1]);

  // ---- interview: cut + box on air in one packet, cut before the box ----
  atem = await fakeAtem();
  await A.switchCameras('127.0.0.1', { program: 2, pip: { on: true, fill: 1, box } }, { port: atem.port });
  assert(packets(atem).join() === 'CKeF+CKDV+CPgI+CKOn', 'interview: fill, box, cut and key on go in one packet, cut before key on (' + packets(atem) + ')');
  assert(atem.log.program === 2 && atem.log.keyer.onAir === true && atem.log.keyer.fill === 1, 'interview: program = interview camera, key 1 on air showing the court camera');
  assert(atem.log.keyer.box.sizeX === 250 && atem.log.keyer.box.x === box.x && atem.log.keyer.box.y === box.y, 'interview: the box is moved and sized');
  const ckdv = atem.log.commands.find((c) => c.name === 'CKDV');
  assert(ckdv.data.length === 64 && ckdv.data.readUInt32BE(0) === 0x0f && ckdv.data.readUInt8(4) === 0 && ckdv.data.readUInt8(5) === 0, 'CKDV: 64 bytes, mask size+position only, M/E 1 key 1');
  atem.close();

  // ---- a keyer that is not a DVE is switched to DVE first ----
  atem = await fakeAtem({ keyType: 0 });
  await A.switchCameras('127.0.0.1', { program: 2, pip: { on: true, fill: 1, box } }, { port: atem.port });
  assert(packets(atem)[0].startsWith('CKTp+') && atem.log.keyer.type === 3, 'a luma keyer is turned into a DVE (picture-in-picture) first');
  atem.close();

  // ---- back to court: key off, cut; no pip = keyer untouched ----
  atem = await fakeAtem();
  atem.log.program = 2;
  atem.log.keyer.onAir = true;
  await A.switchCameras('127.0.0.1', { program: 1, pip: { on: false } }, { port: atem.port });
  assert(packets(atem).join() === 'CPgI+CKOn' && atem.log.program === 1 && atem.log.keyer.onAir === false, 'back to court: the cut and key off in one packet (' + packets(atem) + ')');
  atem.close();
  atem = await fakeAtem();
  await A.switchCameras('127.0.0.1', { program: 2 }, { port: atem.port });
  assert(packets(atem).join() === 'CPgI', 'without pip only the cut is sent');
  atem.close();

  const pip = { on: true, fill: 1, box };
  const toInterview = (kind, seconds = 0.5) => ({ program: 2, pip, transition: { kind, seconds, reverse: false } });
  const toCourt = (kind, seconds = 1) => ({ program: 1, pip: { on: false }, transition: { kind, seconds, reverse: true } });
  const inInterview = (a) => { a.log.program = 2; a.log.preview = 1; a.log.keyer.onAir = true; a.log.keyer.box = { ...box }; a.log.keyFrames = { 1: { ...box, x: -20000 }, 2: { ...box } }; };
  let w;

  // ---- crossfade: the box fades in with the camera; the ATEM's settings put back after ----
  atem = await fakeAtem();
  let t1 = Date.now();
  await A.switchCameras('127.0.0.1', toInterview('mix'), { port: atem.port });
  w = atem.log.wipes[0];
  assert(packets(atem).join() === 'CKeF+CKDV+CPvI+CTTp+CTMx+DAut,CTTp+CTMx', 'mix: box, preview, style, rate and auto in one packet, then the settings back (' + packets(atem) + ')');
  assert(w.kind === 'mix' && w.selection === 3 && w.rate === 25, 'mix: crossfade of background + key 1, 0.5 s = 25 frames at 1080p50 (' + JSON.stringify(w) + ')');
  assert(atem.log.program === 2 && atem.log.keyer.onAir === true, 'mix: interview camera on program, the court box on air');
  assert(atem.log.transition.style === 0 && atem.log.transition.selection === 1 && atem.log.mixRate === 30 && Date.now() - t1 >= 500, 'mix: the ATEM gets its own transition and mix rate back after it');
  atem.close();

  // ---- sharp diagonal wipe with a gold line, right to left going back ----
  atem = await fakeAtem();
  await A.switchCameras('127.0.0.1', toInterview('wipe'), { port: atem.port });
  w = atem.log.wipes[0];
  assert(packets(atem).join() === 'CKeF+CKDV+CPvI+CTTp+CClV+CTWp+DAut,CTTp+CTWp+CClV', 'wipe: gold colour and wipe settings with the auto, then put back (' + packets(atem) + ')');
  assert(w.kind === 'wipe' && w.pattern === 16 && w.reverse === false && w.selection === 3, 'wipe: diagonal pattern, left to right, box included (' + JSON.stringify(w) + ')');
  const ctwp = atem.log.commands.find((c) => c.name === 'CTWp');
  const cclv = atem.log.commands.find((c) => c.name === 'CClV');
  assert(ctwp.data.readUInt16BE(8) === 2002 && ctwp.data.readUInt16BE(12) === 0 && ctwp.data.readUInt16BE(6) > 0, 'wipe: sharp edge, a line in colour generator 2');
  assert(cclv.data.readUInt8(1) === 1 && cclv.data.readUInt16BE(2) === 470, 'wipe: colour generator 2 set to gold');
  assert(atem.log.wipe.pattern === 0 && atem.log.wipe.softness === 8300 && atem.log.color2.hue === 270 && atem.log.transition.style === 0, 'wipe: the ATEM\'s own wipe and colour 2 put back after it');
  atem.close();
  atem = await fakeAtem();
  inInterview(atem);
  await A.switchCameras('127.0.0.1', toCourt('wipe'), { port: atem.port });
  w = atem.log.wipes[0];
  assert(w.reverse === true && w.rate === 50 && atem.log.program === 1 && atem.log.keyer.onAir === false, 'wipe back: right to left, 1 s, the box goes with it');
  atem.close();

  // ---- push: the camera pushes in, then the box flies in from the left ----
  atem = await fakeAtem();
  await A.switchCameras('127.0.0.1', toInterview('push'), { port: atem.port });
  w = atem.log.wipes[0];
  assert(packets(atem).join() === 'CKeF+CKDV+SFKF+CKDV+SFKF+CKDV+CPvI+CTTp+CTDv+DAut,CTTp+CTDv,CKOn+RFlK', 'push: key frames stored, box parked off screen, push, settings back, then key on + fly (' + packets(atem) + ')');
  assert(w.kind === 'dve' && w.selection === 1 && w.dveStyle === 28 && w.reverse === false && w.keyOnAirBefore === false, 'push: DVE push of the background only, the box off air meanwhile (' + JSON.stringify(w) + ')');
  assert(atem.log.keyFrames[1].x < -16000 && atem.log.keyFrames[2].x === box.x && atem.log.keyFrames[2].y === box.y, 'push: key frame A off the left edge, B the box\'s place');
  assert(atem.log.flights.length === 1 && atem.log.flights[0].to === 2 && atem.log.keyer.onAir === true && atem.log.keyer.box.x === box.x, 'push: the box flies to its place (key frame B), on air');
  assert(atem.log.dve.style === 20 && atem.log.transition.style === 0, 'push: the ATEM\'s own DVE effect put back');
  atem.close();
  atem = await fakeAtem();
  inInterview(atem);
  t1 = Date.now();
  await A.switchCameras('127.0.0.1', toCourt('push'), { port: atem.port });
  w = atem.log.wipes[0];
  assert(packets(atem).join() === 'RFlK,CKOn,CPvI+CTTp+CTDv+DAut,CTTp+CTDv', 'push back: the box flies out, goes off air, then the push (' + packets(atem) + ')');
  assert(atem.log.flights[0].to === 1 && w.keyOnAirBefore === false && w.reverse === true && atem.log.program === 1 && Date.now() - t1 >= 1500, 'push back: fly out to key frame A first, then a right to left push');
  atem.close();

  // ---- cut with an overlay: the hook runs first (the overlay covers the frame), then cut + box ----
  atem = await fakeAtem();
  let hookAt = 0;
  await A.switchCameras('127.0.0.1', { program: 2, pip, beforeCut: async () => { hookAt = atem.log.commands.length; } }, { port: atem.port });
  assert(packets(atem).join() === 'CKeF+CKDV+CPgI+CKOn' && hookAt === 0, 'overlay: hook first, then cut and box in one packet (' + packets(atem) + ')');
  atem.close();

  // ---- the camera already there: nothing sent ----
  atem = await fakeAtem();
  await A.switchCameras('127.0.0.1', { program: 1, pip: null, transition: { kind: 'mix', seconds: 1 } }, { port: atem.port });
  assert(packets(atem).length === 0 && atem.log.wipes.length === 0, 'nothing sent when the camera is already on program');
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
