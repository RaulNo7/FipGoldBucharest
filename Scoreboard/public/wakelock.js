/* Keep the phone's screen on while the referee page is open.

   1. Screen Wake Lock API (navigator.wakeLock) - Chrome/Android 84+, Safari/iOS
      16.4+, Firefox 126+. Only on secure pages (https - the tunnel link). The
      browser drops the lock whenever the page goes to the background, so it is
      asked for again each time the page is visible; if the browser wants a tap
      first, the first tap anywhere asks again.
   2. Fallback for the plain-http venue link (and browsers without the API):
      a tiny silent looping video (wakelock.mp4/.webm, 1x1 px, off to the side)
      - phones keep the screen on while a video plays. It is started from the
      first tap (autoplay rules) and resumed when the page comes back.

   Not used inside the desktop app (WebView2): there it would only stop the PC's
   screensaver. The header chip #wakeChip shows the state; tapping it retries. */
(function () {
  'use strict';

  if (window.chrome && window.chrome.webview) return; // desktop app

  const chip = document.getElementById('wakeChip');
  const hasApi = 'wakeLock' in navigator && window.isSecureContext;
  let sentinel = null; // the WakeLockSentinel while the API lock is held
  let video = null; // the fallback video element, once created
  let mode = 'off'; // 'api' | 'video' | 'off'

  function show(state, text, title) {
    if (!chip) return;
    chip.hidden = false;
    chip.className = 'wake-chip ' + state;
    chip.textContent = text;
    chip.title = title;
  }

  function showState() {
    if (mode === 'api' || mode === 'video') {
      show('on', '☀ screen on', mode === 'api' ? 'The screen stays on while this page is open.' : 'The screen stays on while this page is open (video fallback).');
    } else {
      show('off', '☀ tap to keep screen on', 'Tap once so the phone keeps the screen on.');
    }
  }

  // ---- 1. Screen Wake Lock API ----
  async function requestApi() {
    if (!hasApi || document.visibilityState !== 'visible') return false;
    if (sentinel && !sentinel.released) return true;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        if (mode === 'api') mode = 'off';
        showState();
      });
      mode = 'api';
      stopVideo();
      showState();
      return true;
    } catch (_) {
      // NotAllowedError: no tap yet, battery saver, or the browser said no.
      return false;
    }
  }

  // ---- 2. Fallback: a silent looping video ----
  function makeVideo() {
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.muted = true;
    v.loop = true;
    v.preload = 'auto';
    v.title = '';
    // 1x1 and nearly transparent, but on screen: browsers pause off-screen video.
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
    for (const [src, type] of [['wakelock.mp4', 'video/mp4'], ['wakelock.webm', 'video/webm']]) {
      const s = document.createElement('source');
      s.src = src;
      s.type = type;
      v.appendChild(s);
    }
    // Some builds stop at the end even with loop on a fragmented file: restart it.
    v.addEventListener('ended', () => {
      v.currentTime = 0;
      v.play().catch(() => {});
    });
    document.body.appendChild(v);
    return v;
  }

  async function startVideo() {
    if (!video) video = makeVideo();
    try {
      await video.play();
      mode = 'video';
      showState();
      return true;
    } catch (_) {
      return false; // needs a tap first
    }
  }

  function stopVideo() {
    if (video && !video.paused) video.pause();
  }

  // ---- try the API first, the video second ----
  async function keepOn() {
    if (await requestApi()) return;
    if (await startVideo()) return;
    mode = 'off';
    showState();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepOn();
  });
  // A tap anywhere is the user gesture some browsers want (and tapping the chip retries).
  const onTap = () => {
    if (mode === 'off' || (mode === 'video' && video && video.paused)) keepOn();
  };
  document.addEventListener('pointerdown', onTap, { passive: true });
  document.addEventListener('touchstart', onTap, { passive: true });

  showState();
  keepOn();
})();
