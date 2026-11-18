/* Plays the camera transition the server cues (msg.transitionCue):
   { id, kind: 'swipe' | 'logo', dir: 'ltr' | 'rtl', inMs, holdMs, outMs, at }.
   The frame is fully covered from inMs to inMs + holdMs; the server cuts the ATEM in the middle of that. */
(function () {
  'use strict';
  const swipe = document.getElementById('swipe');
  const panel = swipe.querySelector('.swipe-panel');
  const logo = document.getElementById('logo');
  const logoImg = logo.querySelector('.logo-img');
  let lastId = null;
  let running = [];

  function stop() {
    for (const a of running) a.cancel();
    running = [];
    swipe.hidden = true;
    logo.hidden = true;
  }

  function play(cue) {
    stop();
    const total = cue.inMs + cue.holdMs + cue.outMs;
    const holdStart = cue.inMs / total;
    const holdEnd = (cue.inMs + cue.holdMs) / total;
    let anim;
    if (cue.kind === 'logo') {
      logo.hidden = false;
      anim = logo.animate(
        [
          { opacity: 0, offset: 0, easing: 'ease-out' },
          { opacity: 1, offset: holdStart },
          { opacity: 1, offset: holdEnd, easing: 'ease-in' },
          { opacity: 0, offset: 1 },
        ],
        { duration: total, fill: 'forwards' },
      );
      running.push(
        logoImg.animate(
          [{ transform: 'scale(0.92)' }, { transform: 'scale(1)', offset: holdEnd }, { transform: 'scale(1.04)' }],
          { duration: total, fill: 'forwards' },
        ),
      );
    } else {
      // left to right: from off the left edge, over the frame, off the right edge (rtl the other way)
      const from = cue.dir === 'rtl' ? 140 : -140;
      swipe.hidden = false;
      anim = panel.animate(
        [
          { transform: `translateX(${from}%) skewX(-12deg)`, offset: 0, easing: 'cubic-bezier(0.55, 0, 0.35, 1)' },
          { transform: 'translateX(0%) skewX(-12deg)', offset: holdStart },
          { transform: 'translateX(0%) skewX(-12deg)', offset: holdEnd, easing: 'cubic-bezier(0.65, 0, 0.45, 1)' },
          { transform: `translateX(${-from}%) skewX(-12deg)`, offset: 1 },
        ],
        { duration: total, fill: 'forwards' },
      );
    }
    running.push(anim);
    anim.onfinish = () => stop();
  }

  window.PadelClient.connect({
    reloadOnUpdate: true,
    onState(_state, msg) {
      const cue = msg && msg.transitionCue;
      if (!cue || cue.id === lastId) return;
      lastId = cue.id;
      // only a cue that is happening now (not one replayed when the page (re)connects)
      const age = (msg.serverNow || Date.now()) - cue.at;
      if (age >= 0 && age < cue.inMs) play(cue);
    },
  });
})();
