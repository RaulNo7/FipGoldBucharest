# FIP Gold Bucharest 2026 — Scoreboard Controller

Windows WPF (.NET 10) app purpose-built for streaming the **FIP Gold Bucharest 2026** padel tournament (7–13 September 2026) with OBS. It is a fork of [PadelTool](https://github.com/RaulNo7/PadelTool) with the instant-replay / OBS-WebSocket features removed and tournament features added.

## What it does

- Hosts the bundled Node.js score server (`Scoreboard\server.js`) as a hidden child process.
- **Home tab** — embeds the referee remote (`/mobile`): scoring, undo/redo, manual adjust, and per-player serve selection.
- **Score settings tab** — server control + the control panel (`/admin`): pick the two teams of the current match from the official entry lists, overlay display options, OBS overlay URL builder, reset.
- **Teams tab** — the full entry list (58 men's + 31 women's pairs) with an Active/Eliminated toggle per team; eliminated teams cannot be picked for a match. The pair that loses a match is eliminated automatically when the match finishes (reinstated if the result is undone).
- **OBS overlay** (`/overlay`, Browser Source 1920×1080, transparent) — 4 player rows with country flags, serving-player dot, blue completed-set columns, gold current-set games, white points.
- **Court TV display** (`/tv`) — the same scorebug filling the whole screen on a black background, for a TV/laptop/tablet at the court (URL with the LAN address is in the admin panel). It keeps showing the final score during commercial breaks.
- **Players intro** (`/intro`) — a transparent second OBS Browser Source showing the tournament header and the four players with big flags over the court video, toggled with the **Show players** button (Home tab or admin panel); it hides automatically when the match starts.
- **Admin tab** (app-only page `/settings`, never served on the public port) — OBS overlay/intro URLs, court TV URL, the tunnel hostname, the access key and all public links.
- **Main page** (`/`, public) — a Control Center styled after fipgoldbucharest.ro with a menu to all six pages: Scorebug, Court TV (public) and Referee, Score settings, Teams, Media (access key); opening it with `?key=…` stores the key for the control links.
- **Media tab** — the broadcast controls (OBS status, Show/hide players, Show/hide score, Play commercials, Cancel) plus one button per commercial spot (`Commercials\01_FIP_INTRO.mp4` … `06_MONDO.mov`, configurable in `obs-settings.json`). A spot temporarily swaps the file of the OBS media source, plays through the same break routine and restores the merged break video afterwards; the last spot played stays highlighted. After a single spot the score always comes back (spots are for during the game); after "Play all" / the automatic break it comes back only if a live match was interrupted, and stays hidden after a finished match.
- **Commercial breaks** — a configurable delay (default 60s) after a match ends: the scorebug fades off the stream, OBS switches to the commercials scene, the six spots are loaded into its media source **one after another** (no merged file needed; a "single merged file" mode remains available in the settings), and OBS returns to the live scene when the last one ends. The score stays hidden while the next match is set up and reappears when it starts. A "Play commercials now" button runs the same break manually; countdown + Cancel are shown in the admin panel.

## Fixed match format (whole tournament)

- Best of 3 sets, 6 games per set.
- **Star point**: advantage is played at the first two deuces; the third deuce is a single golden point.
- Tiebreak at 6-6, to 7 points, win by 2. The deciding 3rd set is a normal set.

## Data

- `Scoreboard\data\teams.json` — the 89 pairs extracted from the official FIP entry lists (names, countries, rankings). Edit it and restart to add late entries.
- `Scoreboard\public\flags\*.svg` — bundled country flags (from the MIT-licensed [flag-icons](https://github.com/lipis/flag-icons) set), so the overlay works offline.
- Settings: `%AppData%\FipGoldBucharest\settings.json` · live match state: `%AppData%\FipGoldBucharest\scoreboard-state.json`.

## OBS setup for the commercial break

1. **Tools → WebSocket Server Settings** → Enable, note the port (default 4455) and password.
2. Create a scene named `COMMERCIALS` containing one **Media Source** named `Commercials` (any video file — the app loads each spot into it), with **"Restart playback when source becomes active"** ticked. The app also fits the source to the canvas before every break, so spots of any resolution display correctly.
3. In the app's **Media** tab → **Commercial break settings** card (at the bottom): enter the WebSocket URL/password and the scene/source names, press **Test connection** (the result shows in the Broadcast card), then **Save settings**.
4. For the players intro: add `/intro` (URL in the "OBS overlay URL" card) as a **second Browser Source** in the LIVE scene, above the camera, sized **exactly like the OBS canvas** (Settings → Video → Base resolution, e.g. 1920×1080 or 1280×720), then reset its transform (Ctrl+R). The card centers itself and scales with the source; `?scale=0.8` makes it smaller.

Settings are stored server-side in `%AppData%\FipGoldBucharest\obs-settings.json` (never broadcast to referee phones). If OBS is unreachable, scoring keeps working and the error is shown in the card.

## Public HTTPS URL for FIP (fixed for the whole tournament)

The score server also listens on a **read-only port** (main port + 1, i.e. **8081** by default; `PUBLIC_PORT` env to change, `0` to disable). It serves only `/overlay`, `/tv`, `/intro`, their assets, `GET /api/state` and a broadcast-only WebSocket — no control pages, no commands, no settings. Expose **only this port** to the internet through a tunnel with a fixed hostname:

- **Cloudflare Tunnel** (recommended; needs a domain on a free Cloudflare account): Zero Trust → Networks → Tunnels → *Create a tunnel* → install `cloudflared` on the streaming PC as a Windows service (the one-line command shown with the tunnel token) → *Public Hostname*: `scorebug.yourdomain.com` → Service `http://localhost:8081`.
- **Tailscale Funnel** (no domain needed): install Tailscale on the streaming PC, enable Funnel for the tailnet, then `tailscale funnel 8081` → public `https://<pc>.<tailnet>.ts.net`.

The URL to give FIP is then `https://<hostname>/overlay?pos=top-left` (top-left is also the default without `?pos=`; add `&scale=` if they need it). The **court TV** page is public on the same hostname (`https://<hostname>/tv`). The **referee, admin, teams and media pages** are available there too, but only with an **access key**: set the hostname and a key in the admin panel's *Internet access (tunnel)* card (Generate → Save); it then shows the links `https://<hostname>/mobile?key=…`, `/admin?key=…`, `/teams?key=…` and `/media?key=…` — the whole app can be operated remotely. The key unlocks those pages, their APIs and score commands over the public port (opening a page once with `?key=` stores it in a 30-day cookie); without it the internet only sees the scorebug and court TV. Leave the key empty to keep the operator pages LAN-only. It works over HTTPS/WSS as-is and stays the same all week regardless of the venue LAN IP. Keep the PC on a wired connection, the app on auto-start, and the tunnel installed as a service so it survives reboots; test the public URL from a phone on mobile data before the first match.

## Running

Requires Node.js on PATH (or set its path in settings). Build & run:

```
dotnet run --project FipGoldBucharest.csproj
```

The referee opens the phone URL shown on the Home tab (same Wi-Fi network). Add the overlay URL from the Score settings tab as an OBS Browser Source.

Scoring-engine tests: `cd Scoreboard && npm test`.
