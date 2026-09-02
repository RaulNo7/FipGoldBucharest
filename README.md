# FIP Gold Bucharest 2026 — Scoreboard Controller

Windows WPF (.NET 10) app purpose-built for streaming the **FIP Gold Bucharest 2026** padel tournament (7–13 September 2026) with OBS. It is a fork of [PadelTool](https://github.com/RaulNo7/PadelTool) with the instant-replay / OBS-WebSocket features removed and tournament features added.

## What it does

- Hosts the bundled Node.js score server (`Scoreboard\server.js`) as a hidden child process.
- **Home tab** — embeds the referee remote (`/mobile`): scoring, undo/redo, manual adjust, and per-player serve selection.
- **Score settings tab** — server control + the control panel (`/admin`): pick the two teams of the current match from the official entry lists, overlay display options, OBS overlay URL builder, reset.
- **Teams tab** — the full entry list (58 men's + 31 women's pairs) with an Active/Eliminated toggle per team; eliminated teams cannot be picked for a match.
- **OBS overlay** (`/overlay`, Browser Source 1920×1080, transparent) — 4 player rows with country flags, serving-player dot, blue completed-set columns, gold current-set games, white points.
- **Court TV display** (`/tv`) — the same scorebug filling the whole screen on a black background, for a TV/laptop/tablet at the court (URL with the LAN address is in the admin panel). It keeps showing the final score during commercial breaks.
- **Players intro** (`/intro`) — a transparent second OBS Browser Source showing the tournament header and the four players with big flags over the court video, toggled with the **Show players** button (Home tab or admin panel); it hides automatically when the match starts.
- **Broadcast card on the Home tab** — OBS status, Show/hide players, Show/hide score, Play commercials and Cancel, right next to the referee controls (the referee's phone page does not show it).
- **Commercial breaks** — a configurable delay (default 60s) after a match ends: the scorebug fades off the stream, OBS switches to a commercials scene, plays the merged commercials video, and returns to the live scene when it ends. The score stays hidden while the next match is set up and reappears when it starts. A "Play commercials now" button runs the same break manually; countdown + Cancel are shown in the admin panel.

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
2. Create a scene named `COMMERCIALS` containing one **Media Source** named `Commercials` pointing at the merged commercials mp4, with **"Restart playback when source becomes active"** ticked.
3. In the app's Score settings tab → **Commercial break** card: enter the WebSocket URL/password and the scene/source names, press **Test connection**, then **Save settings**.
4. For the players intro: add `/intro` (URL in the "OBS overlay URL" card) as a **second Browser Source** in the LIVE scene, above the camera, sized **exactly like the OBS canvas** (Settings → Video → Base resolution, e.g. 1920×1080 or 1280×720), then reset its transform (Ctrl+R). The card centers itself and scales with the source; `?scale=0.8` makes it smaller.

Settings are stored server-side in `%AppData%\FipGoldBucharest\obs-settings.json` (never broadcast to referee phones). If OBS is unreachable, scoring keeps working and the error is shown in the card.

## Running

Requires Node.js on PATH (or set its path in settings). Build & run:

```
dotnet run --project FipGoldBucharest.csproj
```

The referee opens the phone URL shown on the Home tab (same Wi-Fi network). Add the overlay URL from the Score settings tab as an OBS Browser Source.

Scoring-engine tests: `cd Scoreboard && npm test`.
