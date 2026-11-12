# FRP Live — offline page (Cloudflare Worker)

frplive.ro is served by the score server on the production laptop through the
Cloudflare Tunnel (`fipgold`). When the app is closed or the laptop is off,
Cloudflare has nowhere to send visitors. This Worker sits in front of
`frplive.ro/*` and `www.frplive.ro/*`:

- **App running:** every request (pages, API, WebSocket) is passed through untouched.
- **App closed / laptop off** (origin answers 502–504, 52x or 530): visitors get an
  FRP Live "No match live right now" page (HTTP 503, not cached). It checks
  `/api/state` every 30 s and reloads itself as soon as the score server is back.
  API calls get `503 {"offline":true}` instead of an HTML page.
- **www.frplive.ro** → **frplive.ro** (301, path and query kept), even while the app is off.

The FRP logo is bundled from `Scoreboard/public/frp-mark.png` and served at
`/__offline/frp-mark.png`.

## Deploy / update

From this folder:

```
npx wrangler@4 login     # opens Cloudflare in the browser - approve it there
npx wrangler@4 deploy
```

`wrangler.toml` attaches the Worker to both routes in the `frplive.ro` zone.
The free plan allows 100,000 requests a day. In the dashboard under
**Workers Routes**, set the routes' failure mode to **Fail open** so the site
still works through the tunnel if that limit is ever reached.

To remove it: Cloudflare dashboard → Workers & Pages → `frplive-offline` → delete
(the site then goes back to the tunnel only).
