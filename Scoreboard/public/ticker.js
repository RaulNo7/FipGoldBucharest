/* Announcements bar renderer (/ticker). Cycles through the active
   announcements from the state broadcast, one at a time; a text too long for
   the bar scrolls through once during its turn.

   URL options:
     ?scale=0.9     smaller / larger bar
     ?preview=1     show a sample text when nothing is active (to position it in OBS) */
(function () {
  'use strict';

  const root = document.getElementById('ticker');
  const labelEl = document.getElementById('tickerLabel');
  const windowEl = document.getElementById('tickerWindow');
  const textEl = document.getElementById('tickerText');
  const dotsEl = document.getElementById('tickerDots');

  const params = new URLSearchParams(location.search);
  const scale = parseFloat(params.get('scale'));
  if (scale > 0) root.style.setProperty('--scale', String(scale));
  const preview = params.get('preview') === '1';

  const SCROLL_PX_PER_SEC = 90; // reading speed for long texts (at 1920 wide)
  const HOLD_MS = 1500; // pause before a long text starts scrolling / after it ends
  const SWAP_MS = 350; // fade-out time between two announcements

  let items = []; // [{ id, text }]
  let settings = { visible: true, rotateSeconds: 8, label: 'INFO' };
  let index = 0;
  let currentId = null;
  let currentText = null;
  // One timer per job, so stopping is simple and nothing fires late.
  let swapTimer = null;
  let scrollTimer = null;
  let nextTimer = null;
  let scrollAnim = null;

  PadelClient.connect({
    onState: (_state, msg) => {
      const ann = (msg && msg.announcements) || {};
      if (ann.settings) settings = ann.settings;
      const next = (ann.active || []).map((a) => ({ id: a.id, text: a.text }));
      if (!next.length && preview) next.push({ id: 'preview', text: 'Announcements appear here — this is a preview of the bar' });
      update(next);
    },
  });

  function update(next) {
    items = next;
    labelEl.textContent = settings.label || '';
    const show = (settings.visible !== false || preview) && items.length > 0;
    root.classList.toggle('hidden', !show);
    if (!show) {
      stop();
      currentId = null;
      currentText = null;
      renderDots();
      return;
    }
    const pos = items.findIndex((a) => a.id === currentId);
    if (pos < 0) {
      // Nothing on screen yet, or the current one was switched off: take the one in its place.
      index = Math.min(index, items.length - 1);
      showItem(index, currentId !== null);
    } else {
      index = pos;
      if (items[pos].text !== currentText) showItem(index, true); // edited while on air
      else renderDots();
    }
  }

  function stop() {
    clearTimeout(swapTimer);
    clearTimeout(scrollTimer);
    clearTimeout(nextTimer);
    swapTimer = scrollTimer = nextTimer = null;
    if (scrollAnim) {
      scrollAnim.cancel();
      scrollAnim = null;
    }
  }

  function showItem(i, animate) {
    stop();
    const item = items[i];
    if (!item) return;
    currentId = item.id;
    currentText = item.text;
    renderDots();
    const place = () => {
      swapTimer = null;
      textEl.classList.remove('out');
      textEl.classList.add('in-start');
      textEl.textContent = item.text;
      void textEl.offsetWidth; // reflow: the slide-in starts from below
      textEl.classList.remove('in-start');
      schedule(item);
    };
    if (animate) {
      textEl.classList.add('out');
      swapTimer = setTimeout(place, SWAP_MS);
    } else {
      place();
    }
  }

  /** Plan this item's turn: a long text scrolls through once, then the next one comes. */
  function schedule(item) {
    const pad = parseFloat(getComputedStyle(windowEl).paddingLeft) || 0;
    const overflow = textEl.scrollWidth - (windowEl.clientWidth - pad * 2);
    let slotMs = Math.max(3, Number(settings.rotateSeconds) || 8) * 1000;
    if (overflow > 4) {
      const pxPerSec = SCROLL_PX_PER_SEC * (window.innerWidth / 1920);
      const scrollMs = (overflow / pxPerSec) * 1000;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scrollAnim = textEl.animate(
          [{ transform: 'translateX(0)' }, { transform: `translateX(${-overflow}px)` }],
          { duration: scrollMs, easing: 'linear', fill: 'forwards' }
        );
      }, SWAP_MS + HOLD_MS);
      slotMs = Math.max(slotMs, SWAP_MS + HOLD_MS + scrollMs + HOLD_MS);
    }
    nextTimer = setTimeout(() => {
      nextTimer = null;
      if (currentId !== item.id || !items.length) return;
      index = (index + 1) % items.length;
      // With one announcement: a long text runs again from the start, a short one just stays.
      if (items.length > 1 || overflow > 4) showItem(index, true);
      else schedule(item);
    }, slotMs);
  }

  function renderDots() {
    dotsEl.innerHTML = '';
    if (items.length < 2) return;
    items.forEach((a) => {
      const d = document.createElement('span');
      if (a.id === currentId) d.className = 'on';
      dotsEl.appendChild(d);
    });
  }
})();
