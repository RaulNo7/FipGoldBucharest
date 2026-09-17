/* Replay tag renderer: a Browser Source for OBS's REPLAY scene. The badge
   slides in while a replay clip is on the stream (obs.replay.playing in the
   state broadcast) and slides out when it ends.

   URL options:
     ?pos=top-left | top-right | bottom-left | bottom-right   (default top-left)
     ?scale=0.8      smaller / larger badge
     ?title=0        hide the tournament title line
     ?preview=1      always visible (to position it in OBS) */
(function () {
  'use strict';

  const root = document.getElementById('replayTag');
  const titleEl = document.getElementById('replayTitle');
  const params = new URLSearchParams(location.search);

  const pos = params.get('pos');
  if (['top-right', 'bottom-left', 'bottom-right'].includes(pos)) root.classList.add('pos-' + pos);

  const scale = parseFloat(params.get('scale'));
  if (scale > 0) root.style.setProperty('--scale', String(scale));

  if (params.get('title') === '0') root.classList.add('no-title');

  const preview = params.get('preview') === '1';
  if (preview) root.classList.remove('hidden');

  PadelClient.connect({
    onState: (state, msg) => {
      const d = (state && state.display) || {};
      titleEl.textContent = d.title || 'FIP GOLD BUCHAREST 2026';
      if (preview) return;
      const replay = msg && msg.obs && msg.obs.replay;
      root.classList.toggle('hidden', !(replay && replay.playing));
    },
  });
})();
