/* Scorebug page: builds the iframe embed code and the direct link for the
   overlay from this page's own origin (the public hostname when opened
   through the tunnel). */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  function overlayUrl() {
    const url = new URL('/overlay', location.origin);
    url.searchParams.set('pos', $('#embedPos').value);
    const scale = $('#embedScale').value;
    if (scale && scale !== '1') url.searchParams.set('scale', scale);
    return url.toString();
  }

  function updateEmbed() {
    const src = overlayUrl();
    const w = parseInt($('#embedW').value, 10) || 1920;
    const h = parseInt($('#embedH').value, 10) || 1080;
    $('#embedCode').value =
      `<iframe src="${src}"\n` +
      `        width="${w}" height="${h}" frameborder="0" scrolling="no"\n` +
      `        style="border:0;background:transparent" allowtransparency="true"\n` +
      `        title="FIP Gold Bucharest 2026 - live score"></iframe>`;
    const link = $('#embedLink');
    link.href = src;
    link.textContent = src;
  }

  ['#embedPos', '#embedScale', '#embedW', '#embedH'].forEach((sel) => {
    $(sel).addEventListener('input', updateEmbed);
    $(sel).addEventListener('change', updateEmbed);
  });
  updateEmbed();

  function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = old), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = $('#embedCode');
    const old = ta.value;
    ta.value = text;
    ta.select();
    try {
      document.execCommand('copy');
    } catch (_) {
      /* the text stays selected for a manual Ctrl+C */
    }
    ta.value = old;
    done();
  }

  $('#copyEmbedBtn').addEventListener('click', () => copyText($('#embedCode').value, $('#copyEmbedBtn')));
  $('#copyLinkBtn').addEventListener('click', () => copyText(overlayUrl(), $('#copyLinkBtn')));

  // "YouTube Live" menu entry: shown only while a stream link is set on the Admin tab.
  PadelClient.connect({
    onState: (_s, msg) => {
      const a = $('#youtubeLink');
      const url = (msg && msg.obs && msg.obs.youtubeUrl) || '';
      a.hidden = !url;
      a.href = url || '#';
    },
  });
})();
