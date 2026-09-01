# FIP Gold Bucharest 2026 — Scoreboard Controller

Windows WPF (.NET 10) app purpose-built for streaming the **FIP Gold Bucharest 2026** padel tournament (7–13 September 2026) with OBS. It is a fork of [PadelTool](https://github.com/RaulNo7/PadelTool) with the instant-replay / OBS-WebSocket features removed and tournament features added.

## What it does

- Hosts the bundled Node.js score server (`Scoreboard\server.js`) as a hidden child process.
- **Home tab** — embeds the referee remote (`/mobile`): scoring, undo/redo, manual adjust, and per-player serve selection.
- **Score settings tab** — server control + the control panel (`/admin`): pick the two teams of the current match from the official entry lists, overlay display options, OBS overlay URL builder, reset.
- **Teams tab** — the full entry list (58 men's + 31 women's pairs) with an Active/Eliminated toggle per team; eliminated teams cannot be picked for a match.
- **OBS overlay** (`/overlay`, Browser Source 1920×1080, transparent) — 4 player rows with country flags, serving-player dot, blue completed-set columns, gold current-set games, white points.

## Fixed match format (whole tournament)

- Best of 3 sets, 6 games per set.
- **Star point**: advantage is played at the first two deuces; the third deuce is a single golden point.
- Tiebreak at 6-6, to 7 points, win by 2. The deciding 3rd set is a normal set.

## Data

- `Scoreboard\data\teams.json` — the 89 pairs extracted from the official FIP entry lists (names, countries, rankings). Edit it and restart to add late entries.
- `Scoreboard\public\flags\*.svg` — bundled country flags (from the MIT-licensed [flag-icons](https://github.com/lipis/flag-icons) set), so the overlay works offline.
- Settings: `%AppData%\FipGoldBucharest\settings.json` · live match state: `%AppData%\FipGoldBucharest\scoreboard-state.json`.

## Running

Requires Node.js on PATH (or set its path in settings). Build & run:

```
dotnet run --project FipGoldBucharest.csproj
```

The referee opens the phone URL shown on the Home tab (same Wi-Fi network). Add the overlay URL from the Score settings tab as an OBS Browser Source.

Scoring-engine tests: `cd Scoreboard && npm test`.
