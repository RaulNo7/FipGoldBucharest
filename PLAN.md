# FIP Gold Bucharest 2026 — Implementation Plan

> **Status: IMPLEMENTED (2026-09-01).** All 12 phases of §8 are built and verified (66/66 engine tests, clean `dotnet build`, live browser checks of overlay/admin/teams/mobile, exe smoke test). Still to do on site, per §9: the OBS Browser Source check and the referee-phone-on-LAN test. `C:\Padel\PadelTool` was not modified. This document remains the design reference.
>
> **Phase 2 (2026-09-02): IMPLEMENTED — see §12** (court TV score page + automatic commercial breaks with OBS control). Verified: 84/84 engine tests, a 10/10 end-to-end break test against a mock obs-websocket v5 server (`Scoreboard\test\break.e2e.js`), and live browser checks of `/tv` (1920×1080) and the new admin cards (LAN TV URL, live countdown, Cancel). One implementation simplification vs. the spec: there is no `tv.js` — `tv.html` reuses `overlay.js` via `<body data-tv="1">` (which also makes the /tv page ignore `scoreVisible`), with all TV sizing in `tv.css`. Remaining on-site test: one real break against the user's actual OBS (Test connection button + a finished match).

Everything below is based on a full read of the source project plus two verification passes (a direct read of every relevant file, and an independent research pass), and on the two official FIP entry-list PDFs and the tournament poster.

## Confirmed decisions (user, 2026-09-01)

The user confirmed four §10 questions after this plan was written. Where any text below conflicts, these decisions win:

1. **Deuce rule (§10 item 1) — CONFIRMED**: `deuceMode: 'star'` — advantage is played at the first two deuces, then a single golden point decides the game.
2. **Deciding 3rd set (§10 item 3) — CONFIRMED**: a normal set (to 6 games, tiebreak to 7 win-by-2 at 6-6), i.e. `finalSetMode: 'normal'`.
3. **Scorebug columns (§10 item 4) — CONFIRMED, then refined by a second user screenshot (2026-09-01)**: **blue** column(s) = completed sets (the games score of each finished set, e.g. 6 / 4), **gold** = games in the current set, **white** = current point score (0/15/30/40). The blue columns replace the earlier "small boxes" idea (§6.4).
4. **Point label (user, 2026-09-02)**: the sudden-death point shows **"SP"** (star point) on all score displays instead of the engine's original "GP" — renamed at the source (`pointLabel` in `scoring.js`).
5. **UI language (§10 item 10) — English is kept everywhere.** The Romanian translation pass is dropped; only the 13 mojibake spots in `admin.html` are repaired (§2.8). Every "translate to Romanian" instruction below is void, and implementation phase 11 becomes an encoding-verification pass only.

All other §10 items proceed on this plan's stated recommendations.

---

## 1. Overview

**FipGoldBucharest** is a new standalone Windows WPF (.NET 10) desktop app, built by forking `C:\Padel\PadelTool`, purpose-built for a single event: **FIP Gold Bucharest 2026** (7–13 September 2026, a doubles padel tournament with separate men's and women's draws). Like PadelTool, it hosts a bundled Node.js scoreboard server as a hidden child process, embeds the server's web pages via WebView2 in its own tabs, and lets an operator (desktop) and a referee (phone, over LAN) drive a live score that OBS picks up as a Browser Source overlay. Unlike PadelTool, it has **no OBS integration and no instant-replay feature at all** — every replay-related control, service, hotkey, and WebSocket message is removed. In their place, the app gains a fixed, non-editable tournament ruleset (best of 3 sets, "star" golden-point deuce rule, 7-point tiebreak), a built-in roster of all 89 real entry-list teams (58 men, 31 women) that the operator picks from instead of typing free-text names, an Active/Eliminated toggle per team, operator and referee control over which specific player is serving, and a redesigned overlay/mobile/admin UI themed in the tournament's navy-and-gold palette with a per-player country flag on the scorebug.

---

## 2. Source project analysis

### 2.1 Project shape

`C:\Padel\PadelTool\PadelTool.csproj` (27 lines, full contents):

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>PadelTool</AssemblyName>
    <RootNamespace>ObsReplayController</RootNamespace>
    <ApplicationIcon>app.ico</ApplicationIcon>
    <AssemblyTitle>Padel Tool</AssemblyTitle>
    <Product>Padel Tool</Product>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Web.WebView2" Version="1.0.2903.40" />
  </ItemGroup>
  <ItemGroup>
    <Resource Include="app.ico" />
    <Content Include="Scoreboard\**\*">
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    </Content>
  </ItemGroup>
</Project>
```

Key facts that shape the plan:
- **`RootNamespace` is `ObsReplayController`** — the leftover from an earlier rename the user mentioned. Every `.cs` file uses `namespace ObsReplayController[.Models|.Services]`, and both XAML files declare `x:Class="ObsReplayController.*"`. A rename touches every file.
- **The only NuGet package is `Microsoft.Web.WebView2`.** There is no OBS/websocket package (no `obs-websocket-dotnet`, no `WebSocketSharp`, no `Fleck`). `Services\ObsWebSocketClient.cs` is a hand-written client on top of the framework's own `System.Net.WebSockets.ClientWebSocket`. **Removing replay therefore requires zero `.csproj` package changes** — it's a pure code deletion.
- `UseWindowsForms=true` exists only for the tray icon (`System.Windows.Forms.NotifyIcon`/`ContextMenuStrip`) and `OpenFolderDialog`. Keep it if the new app keeps a tray icon (it should — nothing else needs to change there).
- `<Content Include="Scoreboard\**\*">` is why the whole `Scoreboard\` tree gets copied next to the built exe. Keep this pattern.
- `C:\Padel\PadelTool` is a git repository (confirmed via a second research pass), 4 commits, clean working tree. The most recent commit is titled **"Add Silver point deuce rule, fix Star point to two advantages then sudden death"** — direct evidence that the `'star'` deuce mode (see §2.4) was deliberately built to be exactly "two advantage deuces, then a golden point," which is exactly the tournament rule described in the brief (see §10, item 1).

### 2.2 The three current tabs (`MainWindow.xaml`, `MainWindow.xaml:14` `TabControl x:Name="MainTabs"`)

**Tab 1 — "🏠 Home" (`MainWindow.xaml:17-56`)**

| Control | Type | Line | Purpose |
|---|---|---|---|
| `DotScoreboardHome` | `Ellipse` | 33 | scoreboard server status dot |
| `TxtScoreboardStatusHome` | `TextBlock` | 34 | status text |
| `TxtMobileUrlHome` | `TextBox` (readonly) | 39 | shows the `/mobile` URL |
| *(unnamed)* `Button` | 42 | `Click="BtnCopyMobileUrlHome_Click"` |
| `HomeWebView` | `wv2:WebView2` | 48 | embeds **`/mobile`** — navigated in code at `MainWindow.xaml.cs:792-793` |
| `HomePlaceholder`/`TxtHomePlaceholder` | 49/51 | shown until the WebView is ready |

**Correction to a premise in the brief**: there is **no native WPF "INSTANT REPLAY" button on the Home tab**. The tab only hosts a `WebView2` pointed at `/mobile`; the replay button the user sees there is HTML/JS inside `mobile.html` (see §2.6). Removing it is entirely a `mobile.html`/`mobile.js` change — nothing on this XAML tab references replay at all.

**Tab 2 — "🎾 Score settings" (`MainWindow.xaml:59-152`)**

| Control | Type | Line | Purpose |
|---|---|---|---|
| `DotScoreboard`/`TxtScoreboardStatus` | 88/89 | Node server status |
| `BtnScoreboardStartStop` | 93 | `Click="BtnScoreboardStartStop_Click"` |
| `TxtScoreboardPort` | 99 | `TextChanged="Settings_Changed"` |
| `ChkScoreboardAutoStart` | 102 | auto-start toggle |
| "Open in browser" `Button` | 104 | `Click="BtnOpenAdminBrowser_Click"` |
| "⟳" `Button` | 105 | `Click="BtnScoreboardReload_Click"` |
| `TxtOverlayUrl` + copy `Button` | 121/122 | OBS Browser Source URL |
| `TxtMobileUrl` + copy `Button` | 133/134 | mobile URL (duplicate of Home tab's) |
| `ScoreboardWebView` | 144 | embeds **`/admin`** (`_scoreboard.AdminUrl`) |
| `ScoreboardPlaceholder`/`TxtScoreboardPlaceholder` | 145/147 | placeholder |

All labels on this tab are plain English — **no mojibake and no Romanian text anywhere in this XAML** (see §2.8). Everything the brief wants changed on "Score settings" (match format, free-text teams) is not XAML at all — it lives inside the embedded `admin.html` page (§2.6).

**Tab 3 — "🎥 Replay settings" (`MainWindow.xaml:155-387`) — 100% replay/OBS, removed as one contiguous block**

Every control here exists only to support replay: `BtnConnect` (177, "Connect OBS"), `DotObs`/`TxtObsStatus` (195/196), `DotWatcher`/`TxtWatcherStatus` (205/206, replay-folder `FileSystemWatcher`), `TxtLatestReplay` (214), `DotReady`/`TxtReadyStatus` + 4 readiness checks (231-240), `BtnCheckSetup` (243), **`BtnInstantReplay`** (268-275, the only native "▶ INSTANT REPLAY" button, `Click="BtnInstantReplay_Click"`), `SliderDuration`/`TxtDuration` (285/286), `SliderWait`/`TxtWait` (291/292), `TxtReplayFolder`/`TxtPattern`/`BtnBrowse` (308-316), `ChkSaveReplayFirst`/`ChkAutoPlay`/`ChkGlobalHotkey` (325-327), `DotHotkey`/`TxtHotkeyStatus` (336/339), `BtnOpenFolder` (344), and an `Expander` "OBS setup" (346-381: `TxtObsUrl`, `TxtMediaSource`, `TxtPassword`, `TxtReplayScene`, `TxtLiveScene`).

The **one exception** is `ChkMinimizeToTray` (line 328) — a general tray-behavior toggle that happens to live in this tab today; it needs to be relocated (recommendation: fold it into a small "app" section, e.g. a checkbox near the tray icon behavior on the Home tab, or leave it as a Settings-only field with no dedicated UI control if the new app is expected to just always minimize to tray).

### 2.3 `MainWindow.xaml.cs` — exact replay wiring (925 lines total)

The single most important line to understand the whole replay bridge, in the constructor:

```csharp
// MainWindow.xaml.cs:47-49
// Instant replay requested from the mobile remote page (via the score server).
_scoreboard.ReplayRequested += () =>
    _ = Dispatcher.InvokeAsync(async () => await InstantReplayAsync());
```

`_scoreboard` is a `ScoreboardServerService` (field `MainWindow.xaml.cs:30`); its `ReplayRequested` event (declared `ScoreboardServerService.cs:27`) fires when the Node scoreboard hub broadcasts `{"type":"replay"}` (see §2.5). `_obs` (field `MainWindow.xaml.cs:18`, an `ObsWebSocketClient`) is the actual OBS connection used by `InstantReplayAsync()`.

Fields to remove: `_obs` (18), `_watcher`/`_latestReplay`/`_hwndSource`/`HotkeyIdInstantReplay`/`WM_HOTKEY`/`MOD_NONE` (20-27), `_busy` (22), `RegisterHotKey`/`UnregisterHotKey` P/Invoke declarations (34-38). Keep: `_settings`, `_loading`, `_trayIcon`, `_healthTimer`, `_scoreboard`, `_scoreboardStarted`, `_webViewEnvironmentTask`.

Methods to delete entirely (all replay/OBS-only): `BtnConnect_Click` (154-157), `BtnInstantReplay_Click` (159-162), `BtnBrowse_Click` (164-182), `BtnOpenFolder_Click` (184-193), `TxtPassword_PasswordChanged` (209-214), `UpdateSliderLabels` (216-223), `RegisterGlobalHotkey` (225-272), `UnregisterGlobalHotkey` (274-286), `WndProc` (288-297), `BtnCheckSetup_Click`/`CheckSetupAsync` (347-398), `ConnectAsync` (400-421), `StartWatcher` (423-461), `OnReplayFileChangedAsync` (463-486), `RefreshLatestReplay`/`FindLatestReplay` (488-512), `WaitForNewReplayAsync`/`IsFileReady` (514-547), `InstantReplayAsync` (549-644), `WaitForSavedReplayAsync` (650-672), `WaitForMediaEndAsync` (679-714), `SetStatus` (917-924, becomes dead code once every caller above is gone).

Methods to keep, all already clustered under one comment block (`MainWindow.xaml.cs:716`, `// Padel scoreboard integration`, through line 925): `BtnScoreboardStartStop_Click` (720), `StartScoreboardAsync` (728-762), `StopScoreboard` (764-773), `HideScoreboardViews`/`ShowScoreboardViews` (775-796), `GetWebViewEnvironmentAsync` (798-805 — note it hardcodes the `"ObsReplayController"` WebView2 user-data folder name, a rename candidate), `InitWebViewAsync` (807-833), `BtnScoreboardReload_Click`/`BtnOpenAdminBrowser_Click`/copy-button handlers (835-880), `CheckScoreboardHealthAsync` (882-906), `SetScoreboardStatus` (908-915).

Also trim (don't delete): `LoadSettingsToUi`/`SaveSettingsFromUi`/`UpdateScoreboardUrls`/`Settings_Changed` (95-152, 195-207) — remove the lines that read/write the 13 replay-only `AppSettings` fields (§2.7), keep the scoreboard-port/auto-start/minimize-to-tray lines. Also trim the `_healthTimer` tick handler (60-64) to call only `CheckScoreboardHealthAsync`, not `CheckSetupAsync`. Also remove the tray context menu's "Instant Replay" item (`InitializeTrayIcon`, line 325) but keep the tray icon itself.

### 2.4 `Services\ScoreboardServerService.cs` (329 lines) — does more than start/stop Node

- `StartAsync(port, nodeExePath)` (146-235): if something already answers on the port, reuses it (146-155); else finds `node.exe` via `FindNodeExe` (89-126: explicit setting → `AppContext.BaseDirectory\.node` → hardcoded legacy path **`C:\Padel\ObsPadelScoreBoard\.node`** (line 102) → `PATH`), launches `server.js` as a hidden child process with env vars `PORT`/`STATE_FILE`, polls `/api/state` for ~5s.
- `StateFilePath` (78-82) is hardcoded to `%AppData%\ObsReplayController\scoreboard-state.json` — written by the *Node* process, separate from the C#-side `settings.json`.
- **`StartReplayListener()`/`HandleHubMessage()`** (241-299) — the second half of the replay bridge. The C# side opens its *own* `ClientWebSocket` to the Node hub (`ws://127.0.0.1:{Port}/ws`) purely to watch for `{"type":"replay"}`:
  ```csharp
  // ScoreboardServerService.cs:287-294
  private void HandleHubMessage(string json)
  {
      using var doc = JsonDocument.Parse(json);
      if (doc.RootElement.TryGetProperty("type", out var type) && type.GetString() == "replay")
          ReplayRequested?.Invoke();
  }
  ```
  Delete this method, `HandleHubMessage`, the `public event Action? ReplayRequested;` declaration (line 27), and its two call sites (`StartAsync` line 153 and line 220).
- Everything else (LAN address detection `GetLanAddress`, `IsServerRespondingAsync`, `ScoreboardDirectory`, `FindNodeExe`, process lifecycle) is core infrastructure — **keep unchanged** except renaming the `"ObsReplayController"` AppData folder literal (line 10 area) if doing a full rename.

### 2.5 `Services\ObsWebSocketClient.cs` (236 lines) — delete in its entirety

A complete, hand-written OBS-websocket v5 client (`ClientWebSocket` + `System.Text.Json.Nodes`, SHA-256 challenge/salt auth per the real obs-websocket protocol). Its full public surface — `ConnectAsync`, `DisconnectAsync`, `GetObsVersionAsync`, `IsReplayBufferActiveAsync`, `SceneExistsAsync`, `InputExistsAsync`, `SaveReplayBufferAsync`, `StartReplayBufferAsync`, `GetLastReplayPathAsync`, `GetMediaStateAsync`, `SetCurrentProgramSceneAsync`, `SetMediaSourceFileAsync`, `TriggerMediaRestartAsync` — is **100% replay/scene-switching-for-replay**. There is no scene-collection management, no streaming/recording control, no audio/filter control, nothing unrelated to replay. **This directly answers the brief's requirement to verify whether the OBS service does anything besides replay: it does not. Delete the file wholesale**; nothing else references the class except the (also-deleted) call sites in `MainWindow.xaml.cs`.

### 2.6 The Node scoreboard (`Scoreboard\`) — architecture, routes, WS protocol

`package.json`: name `obs-padel-scoreboard`, `"type":"commonjs"`, **zero runtime dependencies** (only Node built-ins: `http`, `fs`, `path`, `crypto`, `os`), `node >=18`, `"test": "node test/scoring.test.js"` (a test file exists at `Scoreboard\test\scoring.test.js` — worth extending with a case for the tournament's hardcoded config, see §8).

`Scoreboard\src\wsserver.js` (220 lines) is a from-scratch RFC 6455 WebSocket server (`createWsHub`) — manual frame encode/decode, SHA-1 handshake, 30s ping/pong heartbeat, `broadcast`/`sendText`/`onMessage`/`onConnect`. Fully generic, not replay-specific — **keep unchanged**.

`Scoreboard\server.js` (264 lines) routing (208-211): `/` and `/admin` → `admin.html`, `/overlay` → `overlay.html`, `/mobile` → `mobile.html`; `GET /api/state` (195-199), `POST /api/command` (176-193, REST fallback for stream-deck-style tools), `GET /scoring.js` served straight from `src/scoring.js` (202-205) so browser and server share one implementation; WS upgrade only on `/ws` (222-229).

**Complete WebSocket message-type inventory** (every `type` string found anywhere in the tree):

| Direction | Type | Where handled | Notes |
|---|---|---|---|
| C→S | `undo` / `redo` | `server.js:92-110` | history stack |
| C→S | `ping` | `server.js:112-114` | no-op, ws-layer only |
| C→S | **`replay`** | `server.js:116-121` | relayed verbatim to all clients: `{type:'replay', at: ISOtime}` — **removed entirely** |
| C→S | `point`, `adjustPoints`, `adjustGames`, `adjustSets`, `saveSet`, `removeLastSet`, `setServer`, `swapServer`, `setTeams`, `setConfig`, `setDisplay`, `resetMatch`, `resetAll`, `startMatch`, `finishMatch`, `setStatus` | `scoring.js:303-308` (`MUTATING` set), dispatched via `scoring.isMutating()` in `server.js:123` | the scoring engine's command vocabulary (§2.7 below); `finishMatch`/`setStatus` exist in the reducer but are never sent by any current UI |
| S→C | `state` | `server.js:67-69`, pushed on connect and after every mutation | `{type:'state', state, clients: hub.size}` |
| S→C | `replay` relay | as above | **removed** |

There is **no existing per-player serve message and no team-select message** — those are genuinely new (§4).

`Scoreboard\public\client.js` (80 lines, shared by overlay/admin/mobile): `PadelClient.connect({onState,onStatus})` opens `ws://<host>/ws`, auto-reconnects after 1s, and its `send()` falls back to `POST /api/command` if the socket isn't open. **Keep unchanged.**

**Overlay** (`overlay.html` 51 lines / `overlay.js` 141 / `overlay.css` 291): one `#scoreboard` root, a collapsible title bar, then `.board` with **exactly 2 `.team-row` elements** (one per *team*, not per player), each containing: `.accent` (6px color bar), `.serve` (a `●` toggled `.active` — today's only serve indicator, team-level), `.team-info` (`.team-name` + `.players`, where **both player names are joined into one string** — `"P1  /  P2"` — inside a single row), `.sets` (a `.set-box` per completed set, small superscript tiebreak score), `.games` (current game count), `.points` (current point label with `.ad`/`.deuce`/`.gp` modifier classes). A `#winnerBanner` shows on finish. Position/scale are configurable via `?pos=`/`?scale=` query string (`overlay.js:120-140`). **This confirms "4 player rows" is a structural rewrite, not a restyle** — today there are 2 rows, and there is no per-player serve/flag/team-number concept anywhere in the DOM or the data model.

**Mobile** (`mobile.html` 111 lines / `mobile.js` 124 / `mobile.css` 255): topbar with connection dot; a "Live" preview card; a "Scoring" card (+POINT/−point per team, Undo/Redo/**Swap serve**/Start toolbar); a "Manual adjust" card with games/sets steppers **and an already-existing "Serving" row** — `<button class="btn serve" data-serve-pick="0">serve</button>` (`mobile.html:88-91`), wired in `mobile.js:47` to `send({type:'setServer', team: ...})`; a fixed footer with the **`#replayBtn`** ("▶ INSTANT REPLAY", `mobile.html:102-105`), wired in `mobile.js:51-64` (sends `{type:'replay'}`, then disables itself 3s as a double-tap guard). The replay removal here is small and isolated: delete the footer block and its listener. **Team-level serve selection already exists** on this page — the new work is making it per-player (§4), not inventing serve control from nothing.

**Admin** (`admin.html` 206 lines / `admin.js` 289 / `admin.css` 596), served at `/` and `/admin`, laid out as a 2-column grid (collapses under 900px):
- Left column ("col-score"): Live preview (`admin.html:20-28`), **Scoring** card (30-54: point/unpoint buttons, Undo/Redo/Swap serve/Start, plus keyboard hotkeys Q/A/P/L/U/R/S in `admin.js:142-158`), **Manual adjust** card (56-85: same games/sets/serving controls as mobile, plus Save/Undo set).
- Right column ("col-config"): **Teams** card (88-104) — free-text Player 1/Player 2 inputs + a color picker per team, sent via `sendTeams()` (`admin.js:68-79`) — *this is exactly the free-text area the brief wants replaced*; **Match format** card (106-143) — the entire `config` object as a form (deuce rule, sets to win, games/set, tiebreak enabled/points/win-by-two, final set mode, super-tiebreak points), sent via `sendConfig()` (`admin.js:82-96`) — *exactly the area the brief wants removed*; **Overlay display** card (145-165) — title/subtitle text, theme, 4 show/hide toggles; **"OBS overlay URL"** card (167-190) — position/scale pickers building the `?pos=&scale=` query string, Copy/Open buttons — **this card is NOT part of replay**, it only configures the overlay page's own on-screen position inside OBS's Browser Source and must be kept; **Reset** card (192-198) — "Reset score" / "Reset everything".

### 2.7 `Models\AppSettings.cs` — full field list (23 lines)

```csharp
public sealed class AppSettings
{
    public string ObsUrl { get; set; } = "ws://127.0.0.1:4455";
    public string ObsPassword { get; set; } = "";
    public string ReplayFolder { get; set; } = @"C:\Users\crapa\Videos";
    public string ReplayPattern { get; set; } = "Replay *.mp4";
    public string MediaSourceName { get; set; } = "Replay";
    public string ReplaySceneName { get; set; } = "REPLAY";
    public string LiveSceneName { get; set; } = "LIVE";
    public int ReplayDurationSeconds { get; set; } = 15;
    public int WaitForFileSeconds { get; set; } = 5;
    public bool SaveReplayBufferBeforePlaying { get; set; } = true;
    public bool AutoPlayWhenNewReplayAppears { get; set; } = false;
    public bool EnableGlobalHotkey { get; set; } = true;
    public string InstantReplayHotkey { get; set; } = "F10";
    public bool MinimizeToTray { get; set; } = true;
    public bool StartMinimized { get; set; } = false;
    public int ScoreboardPort { get; set; } = 8080;
    public bool ScoreboardAutoStart { get; set; } = true;
    public string ScoreboardNodePath { get; set; } = "";
}
```

13 of 18 fields (`ObsUrl` through `InstantReplayHotkey`) are replay/OBS-only and are deleted. The 5 that survive: `MinimizeToTray`, `StartMinimized`, `ScoreboardPort`, `ScoreboardAutoStart`, `ScoreboardNodePath`. (Minor note: the `ReplayFolder` default hardcodes a personal path, `C:\Users\crapa\Videos` — moot once deleted, flagged only because it's personal data in source.)

`Services\SettingsService.cs` (36 lines): persists `AppSettings` as indented JSON at `%AppData%\ObsReplayController\settings.json` via `System.Text.Json`, PascalCase keys, falls back to `new AppSettings()` on any read error. **Keep unchanged** except the AppData folder-name literal.

### 2.8 Where the encoding problem actually is

Grepping every `.xaml/.html/.js/.css/.cs/.json/.md` file in the project for mojibake markers (`â€`, `ðŸ`, `âˆ`, `â†`, `â‡`, `â–`, `âœ`, `Â·`, plus the specifically-Romanian patterns `Ã®`/`È™`/`Èƒ`) turns up **exactly one corrupted file: `Scoreboard\public\admin.html`.** No XAML file, no `.cs` file, and no other `Scoreboard\public\*` file is affected.

**Important correction to the brief's premise**: none of the corruption is Romanian. There is **no Romanian text anywhere in the current PadelTool codebase** — every label, in every file, including the corrupted ones, is English. What's corrupted is typographic punctuation and one emoji: em dash, ellipsis, middle dot, curly quotes, the arrows `↶ ↷ ⇄ ▶`, the check `✔`, and `🎾`. See §10 for how this changes the framing of the "fix labels" work.

Every corrupted instance in `admin.html`, with the correct character:

| Line | Corrupted | Correct |
|---|---|---|
| 6 | `Padel Scoreboard â€” Control` | `Padel Scoreboard — Control` (em dash) |
| 11 | `ðŸŽ¾ Padel Scoreboard` | `🎾 Padel Scoreboard` |
| 14 | `connectingâ€¦` | `connecting…` |
| 37, 65-66 (×2 more) | `âˆ' point` / `âˆ'` (step buttons) | `−` (U+2212 minus sign) |
| 48, 82 | `â†¶ Undo` / `â†¶ Undo set` | `↶` |
| 49 | `â†· Redo` | `↷` |
| 50 | `â‡„ Swap serve` | `⇄` |
| 51 | `â–¶ Start` | `▶` |
| 53 (×3) | `... point/undo-point Â· ...` | `·` (middle dot) |
| 81 | `âœ” Save set` | `✔` |
| 84 | `...overlay â€" use it to build...` | `— use it to build` |
| 189 | `Sources â†' + â†' Browser â†' ... tick â€œtransparentâ€.` | `→ ... → ... "transparent".` |

**Root cause, with byte-level proof**: `admin.html` is the *only* file in the tree that starts with a UTF-8 BOM (`EF BB BF`); every sibling file (`mobile.html`, `overlay.html`, `admin.css`, `MainWindow.xaml`, etc.) has no BOM. Reading the raw bytes around `"connecting"` gives `43 6F 6E 6E 65 63 74 69 6E 67 C3 A2 E2 82 AC C2 A6`. Decoding the tail `C3 A2 E2 82 AC C2 A6` as UTF-8 yields exactly the 3-character string `â€¦`. That 3-character string is precisely what you get by taking the *correct* UTF-8 bytes of an ellipsis (`E2 80 A6`) and misreading each byte individually as Windows-1252 (`E2`→`â`, `80`→`€`, `A6`→`¦`) — then that mis-decoded string was saved back out as UTF-8 (which is why it now takes 7 bytes instead of 3, and why the file grew a BOM it didn't have before). The same arithmetic checks out for the em-dash case. **Conclusion: this is a genuine double-encoding** (correct UTF-8 → misread as CP-1252 → re-saved as UTF-8), not a file that was simply "never converted from ANSI." It is isolated to this one file, which is also the only BOM'd file — consistent with `admin.html` having been individually opened and re-saved once through a different, non-UTF-8-aware editor/tool than every other file in the same folder. The fix is a one-time manual retype of the 13 spots above when the file is carried over, saved as plain UTF-8 (matching its siblings, no BOM needed since the page already declares `<meta charset="UTF-8">`).

### 2.9 Scoring engine (`Scoreboard\src\scoring.js`, 467 lines) — the tournament rule already exists

`createDefaultState().config` (lines 48-58):

```js
config: {
  deuceMode: 'golden',       // 'golden' | 'advantage' | 'silver' | 'star'
  starDeuceLimit: 3,
  gamesPerSet: 6,
  setsToWin: 2,              // best of 3
  tiebreakEnabled: true,
  tiebreakPoints: 7,
  tiebreakWinByTwo: true,
  finalSetMode: 'normal',    // 'normal' | 'tiebreak' | 'superTiebreak'
  superTiebreakPoints: 10,
},
teams: [
  { name: '', players: ['Player 1', 'Player 2'], color: '#1e88e5', logo: '' },
  { name: '', players: ['Player 3', 'Player 4'], color: '#e53935', logo: '' },
],
```

The doc comment at the top of the file (lines 10-21) spells out four deuce modes, and `'star'` is described as: *"two advantage deuces (40-40 and 4-4), then the next deuce (5-5) is a sudden-death point. The threshold can still be overridden via `starDeuceLimit`."* This is — almost word for word — the brief's own description of the rule ("2 deuce and the golden point"). Combined with the git commit that explicitly introduced/fixed this exact mode, this is the tournament's ruleset already implemented, not something to build. See §10 for the recommendation.

`gamesPerSet: 6, setsToWin: 2 (best of 3), tiebreakEnabled: true, tiebreakPoints: 7, tiebreakWinByTwo: true` already match the brief's spec exactly. **The only default that needs to change is `deuceMode: 'golden'` → `'star'`** (keep `starDeuceLimit: 3`).

`gameWinner()`/`pointLabel()` (95-157) implement the point-label logic (`'0'|'15'|'30'|'40'`, `D1/D2…`, `Ad1/Ad2…`, `'GP'`) for all four modes — no changes needed there. The reducer `applyCommand()` (325-448) is a `switch` over `cmd.type`, always cloning state first, which is how undo/redo works (`server.js` keeps `undoStack`/`redoStack`).

`state.teams[i]` today is `{name, players: [string, string], color, logo}` — no country, no id linking to a roster, no active flag. `state.server` is a **team-level** index (0 or 1) — there is no concept of which specific player, within the serving team, currently holds serve. Both gaps are addressed in §4.

---

## 3. What is removed / kept / changed

### 3.1 C# / WPF side

| Item | File | Location | Action |
|---|---|---|---|
| OBS websocket client | `Services\ObsWebSocketClient.cs` | entire file | **Delete** |
| `_obs` field | `MainWindow.xaml.cs` | 18 | Delete |
| `ReplayRequested` subscription | `MainWindow.xaml.cs` | 47-49 | Delete |
| F10 hotkey fields/consts/P-Invoke | `MainWindow.xaml.cs` | 24-28, 34-38 | Delete |
| `RegisterGlobalHotkey`/`UnregisterGlobalHotkey`/`WndProc` | `MainWindow.xaml.cs` | 225-297 | Delete |
| All replay/OBS click handlers & helpers (see §2.3 full list) | `MainWindow.xaml.cs` | 154-644, 650-714, 917-924 | Delete |
| Tab 3 "🎥 Replay settings" | `MainWindow.xaml` | 155-387 | Delete whole `TabItem` |
| `ChkMinimizeToTray` | `MainWindow.xaml` | 328 (inside Tab 3) | Relocate elsewhere before deleting the tab |
| Tray "Instant Replay" menu item | `MainWindow.xaml.cs` | 325 | Delete just this item, keep the tray icon |
| `ReplayRequested` event + `StartReplayListener`/`HandleHubMessage` | `Services\ScoreboardServerService.cs` | 27, 241-299, call sites 153/220 | Delete |
| 13 replay/OBS `AppSettings` fields | `Models\AppSettings.cs` | 5-17 | Delete (keep the other 5) |
| `_healthTimer` tick calling `CheckSetupAsync` | `MainWindow.xaml.cs` | 60-64 | Trim to `CheckScoreboardHealthAsync` only |
| `LoadSettingsToUi`/`SaveSettingsFromUi`/`Settings_Changed` | `MainWindow.xaml.cs` | 95-152, 195-207 | Trim to surviving fields |
| Serve-correction control | new, Tab 1 | — | **Add** (§6.1) |
| Tab 3 "Teams" | new | — | **Add** (§6.3) |
| Namespace/assembly rename | project-wide | — | `ObsReplayController` → `FipGoldBucharest`, `PadelTool` → `FipGoldBucharest` |

### 3.2 Node / web side

| Item | File | Location | Action |
|---|---|---|---|
| `replay` WS command | `Scoreboard\server.js` | 116-121 | Delete |
| Footer "INSTANT REPLAY" button | `Scoreboard\public\mobile.html` | 102-105 | Delete |
| `#replayBtn` listener | `Scoreboard\public\mobile.js` | 51-64 | Delete |
| "Live" / "Scoring" / "Manual adjust" cards (left column) | `Scoreboard\public\admin.html` | 20-85 | **Delete** — redundant with Tab 1's embedded `/mobile` (confirm with user, §10) |
| Corresponding bindings + keyboard shortcuts | `Scoreboard\public\admin.js` | 37-58, 142-158 | Delete |
| Free-text "Teams" card | `Scoreboard\public\admin.html` | 88-104 | **Replace** with a team-picker (§4, §6.2) |
| `sendTeams()` | `Scoreboard\public\admin.js` | 68-79 | Replace with `selectTeam` send logic |
| "Match format" card | `Scoreboard\public\admin.html` | 106-143 | **Delete** (format is hardcoded, §2.9) |
| `sendConfig()` + its `change`/`input` listeners | `Scoreboard\public\admin.js` | 82-100 | Delete the UI wiring (leave `setConfig` in the reducer, unused but harmless) |
| Country flags | new, `Scoreboard\public\flags\*.svg` | — | **Add** (§5) |
| `teams.json` seed data | new, `Scoreboard\data\teams.json` | — | **Add** (§4, §11) |
| `GET /api/teams` route | new, `Scoreboard\server.js` | — | **Add** |
| `/teams` page (`teams.html`/`.js`) | new, `Scoreboard\public\` | — | **Add** (§6.3) |
| `selectTeam`, `setTeamActive`, `setServingPlayer`, `swapServingPlayer` WS commands | `Scoreboard\src\scoring.js` | — | **Add** to `MUTATING` + reducer |
| `deuceMode` default | `Scoreboard\src\scoring.js` | 49 | `'golden'` → `'star'` |
| Overlay DOM (2 team-rows → 4 player-rows) | `Scoreboard\public\overlay.html`/`.js`/`.css` | — | **Rewrite** (§6.4) |
| Per-player country + flag rendering | `Scoreboard\public\overlay.js`, `mobile.js` | — | **Add** |
| Mojibake in the surviving admin.html markup | `Scoreboard\public\admin.html` | 6,11,14,37,48-53,65-66,81-82,84,189 | **Fix** (retype as clean UTF-8, no BOM) |
| Romanian translation of all end-user labels | all `public\*.html` | — | ~~Add~~ **Dropped — user chose to keep English (see Confirmed decisions)** |
| Colour palette (CSS custom properties) | `admin.css`, `mobile.css`, `overlay.css` | — | **Replace** (§7) |

### 3.3 Kept unchanged (explicitly — don't touch during the retheme/rewrite pass)

- `Scoreboard\src\wsserver.js` — generic WS transport.
- `Scoreboard\public\client.js` — shared reconnect/send wrapper.
- `Services\SettingsService.cs` (except the AppData folder-name literal), `App.xaml.cs` (except the mutex/event-name literals).
- The **"OBS overlay URL"** card in `admin.html` (167-190) — it only builds the `?pos=&scale=` query string for the overlay's on-screen position inside OBS; it has nothing to do with the OBS websocket/replay feature and must survive the "remove everything OBS" pass.
- The **"Overlay display"** card (145-165) and the **"Reset"** card (192-198) in `admin.html`.
- The App.xaml `Card`/`PrimaryButton`/`SecondaryButton`/`TabControl`/`TabItem` style *structures* (only their `Color` values change, §7).

---

## 4. New data model

### 4.1 `teams.json` (new, static seed data, ships with the app)

Location: **`Scoreboard\data\teams.json`** (a new `data\` folder, sibling to `public\` and `src\` — deliberately *not* under `public\`, since it's read server-side, not served as a raw static file directly to browsers; the server exposes it through `GET /api/teams` instead).

Schema (per the brief's required fields, plus a few enrichment fields kept because they're genuinely present in the source PDFs and cost nothing to carry — marked optional):

```jsonc
{
  "tournament": "FIP Gold Bucharest 2026",
  "teams": [
    {
      "id": "M-MD-01",              // required. Format: {M|W}-{MD|Q}-{2-digit position}
      "category": "men",            // required. "men" | "women"
      "section": "main_draw",       // required. "main_draw" | "qualifying"
      "position": 1,                // required. Pos column from the entry list
      "wildcard": false,            // required. true for entries marked WC in the source PDF
      "active": true,               // required. Toggled by the new "Teams" tab; false = eliminated
      "teamPoints": 3213,           // optional (source: "Team Points" column)
      "players": [
        { "name": "Enzo Jensen Sirvent", "country": "ITA", "ranking": 47,  "rankingPoints": 1278 },
        { "name": "David Gala",          "country": "ESP", "ranking": 34,  "rankingPoints": 1935 }
      ]
    }
    // ...89 entries total, see §11 for the complete file
  ]
}
```

- `country` is the exact 3-letter code as printed in the PDF (FIP/IOC codes, e.g. `GER` not `DEU`, `POR` not `PRT` — see §5 for the full mapping to ISO-3166 alpha-2 for flag lookup).
- `active` in `teams.json` itself is just the *shipped default* (always `true`). The **live, mutable** value the app actually reads/writes at runtime lives in `scoreboard-state.json` (§4.2) — `teams.json` is never rewritten by the app.
- 14 unfilled reserve slots in the men's qualifying sheet (positions 31-44, labelled WC/AWC with no names) and 13 unfilled reserve slots in the women's sheet (2 in main draw, 11 in qualifying) are **not** included as entries (there is no player data for them) — see §11 for the exact counts.

### 4.2 `scoreboard-state.json` changes (the existing runtime/match state file)

Still the same file and the same debounced-write mechanism (`server.js`'s `persist()`, 200ms debounce) — just a richer shape:

- `state.teams[i].players` changes from `[string, string]` to `[{name, country}, {name, country}]`.
- `state.teams[i]` gains `teamId: string | null` — which `teams.json` entry this side currently is (null if never selected, e.g. right after "Reset everything").
- New top-level field `state.servingPlayer: 0 | 1` — which player *within* the serving team (`state.server`) currently has the serve. Default `0`.
- New top-level field `state.teams_registry: { [teamId: string]: { active: boolean } }` — the live Active/Eliminated flags for all 89 teams. Hydrated at server boot exactly the way `config`/`display`/`teams` are already defensively merged in `loadState()` (`server.js:24-42`): for every id in `teams.json` not already present in the loaded `teams_registry`, default it to `{active: true}`. This means adding a team to `teams.json` later (e.g. a late wildcard) just works on next restart without a migration step.

### 4.3 WebSocket protocol changes

| Type | Direction | Payload | Behavior |
|---|---|---|---|
| `selectTeam` | C→S | `{team: 0\|1, teamId: string}` | Look up `teamId` in the in-memory `teams.json` data; set `state.teams[team] = {teamId, name:'', players:[...], color: <unchanged>, logo: <unchanged>}`. Replaces the old free-text `setTeams` for this purpose (that command stays in the reducer, just unused by any UI). |
| `setTeamActive` | C→S | `{teamId: string, active: boolean}` | `state.teams_registry[teamId].active = active`; broadcasts new state so the Teams tab and any team-picker dropdowns update live. |
| `setServingPlayer` | C→S | `{player: 0\|1}` | `state.servingPlayer = player` (does not change `state.server`). |
| `swapServingPlayer` | C→S | `{}` | `state.servingPlayer = 1 - state.servingPlayer` — the quick "wrong partner" correction button, mirroring the existing `swapServer` UX pattern. |
| `replay` | — | — | **Removed entirely** (client and server). |

~~`setServer`/`swapServer` (existing, team-level) should reset `state.servingPlayer` to `0` when the serving team changes.~~ **Superseded (2026-09-02, user request): proper padel serve rotation.** A new `state.teamServers: [0|1, 0|1]` remembers which partner serves each team's *next* service game. After every completed game (and after every tiebreak serving stint) the team that just served rotates to its partner, and the incoming team serves with its remembered partner — so the same player no longer serves every one of their team's turns. `setServer`/`swapServer` switch to the incoming team's remembered server; `setServingPlayer`/`swapServingPlayer` re-anchor the current team's rotation; `selectTeam` resets that side's rotation to player 1. The overlay's serving dot still targets `state.teams[state.server].players[state.servingPlayer]`.

No other existing message types change shape. `state`-push and the REST `/api/command` fallback continue to work unmodified for all of the above, since they're just additional `cmd.type` cases in the same reducer.

---

## 5. Flags approach

Bundle SVG flags locally at **`Scoreboard\public\flags\{iso2}.svg`** (lowercase ISO-3166-1 alpha-2 filenames) — no CDN, so the overlay keeps working with OBS's Browser Source offline/without internet, and nothing breaks if the venue Wi-Fi is down. A convenient, permissively-licensed (MIT) source to vendor these 30 files from is the `flag-icons` project (`flags/4x3/{iso2}.svg}` in that repo) — this is a fetch-and-copy step for the implementation phase (§8), not something performed by this planning pass.

Render one `<img class="flag" src="/flags/{iso2}.svg" alt="{iso3}">` per **player row** (not per team — each of the 4 rows gets its own flag, since padel pairs are frequently mixed-nationality, e.g. men's main draw #8 is ARG/MEX). If a code is ever missing from the folder, fall back to a plain grey placeholder box rather than a broken `<img>`.

**Exact ISO3(-as-printed) → ISO2 mapping needed** — every one of the 30 distinct country codes that actually appears across both entry lists (verified by enumerating every `country` value in §11's data):

| Printed code | Country | ISO2 (flag filename) |
|---|---|---|
| ALG | Algeria | `dz` |
| ARG | Argentina | `ar` |
| AUT | Austria | `at` |
| BRA | Brazil | `br` |
| COD | DR Congo | `cd` |
| CRO | Croatia | `hr` |
| CZE | Czech Republic | `cz` |
| DEN | Denmark | `dk` |
| ESP | Spain | `es` |
| FIN | Finland | `fi` |
| FRA | France | `fr` |
| GBR | Great Britain | `gb` |
| GER | Germany | `de` |
| GRE | Greece | `gr` |
| ITA | Italy | `it` |
| MDA | Moldova | `md` |
| MEX | Mexico | `mx` |
| NED | Netherlands | `nl` |
| OMA | Oman | `om` |
| PAR | Paraguay | `py` |
| POL | Poland | `pl` |
| POR | Portugal | `pt` |
| QAT | Qatar | `qa` |
| ROU | Romania | `ro` |
| SLO | Slovenia | `si` |
| SVK | Slovakia | `sk` |
| SWE | Sweden | `se` |
| UAE | United Arab Emirates | `ae` |
| UKR | Ukraine | `ua` |
| USA | United States | `us` |

Note several of these are FIP/IOC codes, not strict ISO-3166 alpha-3 (`GER`≠`DEU`, `POR`≠`PRT`, `DEN`≠`DNK`, `NED`≠`NLD`, `SLO`≠`SVN`, `CRO`≠`HRV`, `ALG`≠`DZA`, `GRE`≠`GRC`) — the mapping above is keyed off the *actual printed codes*, which is what matters since that's what's in `teams.json`.

Suggested lookup implementation: a single small JS object `ISO3_TO_ISO2` (exactly the 30 pairs above) shared between `overlay.js` and `mobile.js`/`teams.js` (could live in a new tiny `Scoreboard\public\countries.js`, loaded the same way `scoring.js` is shared).

---

## 6. Tab-by-tab spec

### 6.1 Tab 1 — Home

Unchanged shell from today (status dot, mobile-URL box + Copy button, embedded WebView2 pointed at `/mobile`) **minus nothing on the WPF side** — the Instant Replay removal happens entirely inside `/mobile` (§6.5), which is what this tab mirrors. No new native WPF controls are needed on this tab for serve control either, **provided** the "Serving" row already being added to `/mobile` (§6.5) is per-player — since Tab 1 is defined as "an exact embed/mirror" of `/mobile`, the operator gets player-level serve correction automatically once `/mobile` has it. Keep the existing "Copy" button and status row as-is (retheme colors only, §7).

### 6.2 Tab 2 — Score settings

WPF shell unchanged (server start/stop, port, auto-start, overlay/mobile URL boxes + Copy buttons, embedded WebView2 pointed at `/admin`) — again, all the real content changes are inside the embedded page:

`admin.html` after the changes (§3.2):
- Left column: **removed** (Live preview / Scoring / Manual adjust — redundant with Tab 1, confirm with user per §10).
- Right column, top to bottom:
  1. **Match** card *(new, replaces the free-text Teams card)* — two dropdowns ("Side 1", "Side 2"), each populated from `GET /api/teams` filtered to `active !== false`, grouped by "Men — Main Draw / Qualifying" and "Women — Main Draw / Qualifying" `<optgroup>`s, showing `"12. A. Cepero (ESP) / P. Aliaga (ESP)"`-style labels. Selecting an option sends `{type:'selectTeam', team, teamId}`. A small live preview under each dropdown shows the two flags + names, confirming the pick before it goes to air.
  2. **Overlay display** card — kept as today (title/subtitle/theme/show-toggles), labels kept in English; consider dropping the light-theme option since the new branding is a fixed dark-navy/gold look (flagged in §10).
  3. **"OBS overlay URL"** card — kept as today, English labels.
  4. **Reset** card — kept as today, English labels.

### 6.3 Tab 3 — Teams (new)

Follows the exact same architectural pattern as Tabs 1/2: a thin WPF `TabItem` containing a `WebView2` (e.g. `x:Name="TeamsWebView"` + a placeholder, copy-pasted from the `ScoreboardWebView`/`HomeWebView` pattern in `MainWindow.xaml.cs`) pointed at a new route, **`/teams`** → new file **`Scoreboard\public\teams.html`** (+ `teams.js`, sharing `admin.css` or a small new `teams.css`).

Page content: two sections ("Bărbați" / "Doamne"), each listing every team in that category grouped by "Tabloul principal" (main draw) / "Calificări" (qualifying), sorted by `position`. Each row: position number, wildcard badge if `wildcard:true`, two flags + two names, and an Active/Eliminated toggle switch. Toggling sends `{type:'setTeamActive', teamId, active}`. The page uses the same `PadelClient.connect()` pattern as the other pages so it live-updates if toggled from two places at once, and greys out (rather than hides) eliminated teams in its own list too, for consistency. This same live `teams_registry` state is what the Tab 2 match-picker dropdowns filter against.

### 6.4 Overlay redesign (`overlay.html`/`.js`/`.css`)

Structural rewrite from 2 team-rows to **4 player-rows**, grouped visually into two team blocks of 2 rows each, on a dark rounded-corner panel (matching the reference screenshot):

```
┌────────────────────────────────────────────────────────┐
│ [flag] "1"   A. SALAZAR BENGOECHEA           │blue│gold│white│
│ [flag]       A. OSORO ULRICH  ●              │ 6  │ 1  │ 30  │   <- ● = serving player
├────────────────────────────────────────────────────────┤
│ [flag] "2"   L. RUFO ORTIZ                   │blue│gold│white│
│ [flag]       V. IGLESIAS SEGADOR             │ 4  │ 5  │ 15  │
└────────────────────────────────────────────────────────┘
  blue  = one column per COMPLETED set (games of that set — here set 1 ended 6-4)
  gold  = games in the CURRENT set (here 1-5 in set 2)
  white = current game points 0/15/30/40 (here 30-15)
```

Concretely:
- `.board` gets 4 `.player-row` elements (2 per `.team-block`), replacing the 2 `.team-row`s.
- Each `.player-row`: `.flag` (`<img>`, §5) at the far left; a `.team-number` ("1"/"2") shown once, vertically centered **between** the two flags of a team block (i.e. positioned via the team-block wrapper, not repeated per row); `.player-name` in uppercase condensed white text, formatted `"{first-initial}. {surname(s)}"` (e.g. `"A. SALAZAR BENGOECHEA"` — derive the initial from the first token of the stored `name` and treat the remaining tokens as the surname block; flag ambiguous multi-part first names as a display nuance, not a data problem, since the underlying `name` field stays the full name as printed); a `.serve-dot` (small green circle, reusing the existing app accent green `#22C55E`, §7) shown only next to `state.teams[state.server].players[state.servingPlayer]`.
- **Score columns** (right side; each rendered once per team block, spanning both player rows, not duplicated per row): first the **blue column(s)** (cobalt `--blue-accent` `#2E6CA4` background, white text) — **one column per completed set**, showing the games that team won in that set (keep today's `.set-box` tiebreak superscript); zero blue columns at match start, up to two while a 3rd set is in progress. Then the **gold column** (gold background, white text) = `state.games[teamIdx]`, games in the current set.
- The **white column** (white background, dark text) = the current point label (`pointDisplay()`, unchanged logic from today) — likewise one per team block, not per player.
- The blue completed-set columns are the direct successor of today's `.sets`/`.set-box` element (same data source), restyled full-height to match the gold/white columns — fixed by the user's second reference screenshot (2026-09-01), which showed set 1 finished 6-4 in blue, current set 1-5 in gold, points 30-15 in white. The earlier "small muted boxes" idea is superseded.
- **Layout refinements** (user request 2026-09-02, post-implementation): the small "1"/"2" team numbers were removed everywhere, and the board width changed from fixed 620px to `fit-content` (min 400px / max 660px) so the score columns sit close to the player names instead of leaving a wide gap.
- **Finished match** (user request 2026-09-01, post-implementation): when `status === 'finished'`, the gold current-set column and the white points column are hidden on the overlay (and on the mobile mini-preview) — only the blue completed-set columns remain, plus the winner banner.
- Winner banner, position/scale query-string handling, and the transparent-background/`[data-theme]` mechanism in `overlay.css` are all kept structurally — only the color tokens change (§7) and the theme is effectively pinned to the new dark/gold look (the `light` variant can be dropped or kept dormant, per §10).

### 6.5 Referee mobile page (`/mobile`)

Keep: connection indicator, Live preview, Scoring card (point/undo-point, Undo/Redo/Swap-serve/Start), Manual adjust card (games/sets steppers, Save/Undo set). **Remove**: the footer "▶ INSTANT REPLAY" button and its listener (`mobile.html:102-105`, `mobile.js:51-64`). **Add**: extend the existing "Serving" row from team-level (`data-serve-pick="0"/"1"`) to also let the referee pick the specific player — recommendation: keep the two big team-level "serve" buttons (sends `setServer`) for picking *which team* serves, and add a second, smaller row of 4 player-name buttons (or 2 pairs of "P1"/"P2" mini-toggles under each team's serve button) that sends `setServingPlayer`/`swapServingPlayer` for *which partner*. All labels stay English.

---

## 7. Color palette

Derived by downloading and visually inspecting the official poster (`https://www.padelfip.com/wp-content/uploads/2025/12/Poster-GOLD@05x-1-724x1024.jpg`, saved locally, 75.5 KB, download succeeded — no fallback-to-defaults needed). The poster is a diagonal composition: a gold/amber gradient in the upper-left, deepening into near-black navy across the lower-right, with a bold white "BUCHAREST" wordmark, a gold "FIP GOLD" wordmark, and a cobalt-blue gradient band behind the athletes.

| Token | Hex | Sampled from | Role |
|---|---|---|---|
| `--navy-deep` | `#0B1B2E` | Poster's bottom-right corner / sponsor-logo band | Window chrome background, overlay panel background, admin/mobile page background |
| `--navy-panel` | `#142943` | Slightly lightened from the deep navy | Card/panel background (replaces today's `PanelColor #121821`) |
| `--navy-panel-2` | `#1B3454` | Further lightened | Secondary panel / alternating row background (replaces `Panel2Color #182131`) |
| `--gold-primary` | `#D4A017` | The "FIP GOLD" wordmark and the poster's gold gradient | Primary accent: buttons, highlights, the scorebug's gold games column |
| `--gold-light` | `#E8C158` | Lighter gold gradient area, upper-left of the poster | Hover states, borders, gradients |
| `--blue-accent` | `#2E6CA4` | The cobalt gradient band behind the athletes | **Scorebug completed-set columns** (white text); secondary accent (links, inactive-tab indicator, subtle borders) |
| `--white` | `#FFFFFF` | "BUCHAREST" wordmark | Primary text on dark backgrounds; text on the gold score column |
| `--text-dark` | `#10202F` | — (functional, not sampled) | Text on the white score column / light surfaces |
| `--text-muted` | `#9FB1C4` | — (functional) | Secondary/disabled labels on navy (e.g. eliminated-team text) |
| `--serve-green` | `#22C55E` | **Kept from the existing app**, not poster-derived | Serving-player dot — reused deliberately: it's already the app's accent green (identical byte-for-byte in `App.xaml`'s `AccentColor` and `mobile.css`'s `--green`), reads clearly against navy, and a green "who's serving" dot is a familiar/neutral color choice independent of team branding |
| `--danger` | `#EF4444` | Kept from existing `DangerColor` | Reset/destructive buttons |
| `--warning` | `#F59E0B` | Kept from existing `WarningColor` | "Starting/connecting" status dots (kept distinct from `--gold-primary` — check side-by-side in the finished UI since both are yellow-family) |

Applied to: `App.xaml`'s `Color`/`SolidColorBrush` resources (swap the 10 `Color x:Key` values, keep every `Style`/`ControlTemplate` structure as-is), `admin.css`'s `:root` block (today: `--bg:#0e1118, --panel:#171b26, --accent:#f5c518, --green:#2ecc71, --red:#e74c3c`), `mobile.css`'s `:root` block (today: `--bg:#0b0e14, --green:#22c55e, --yellow:#f5c518`), and `overlay.css`'s `[data-theme='dark']` block (today: `--bg:rgba(17,20,28,.92), --points-bg:#f5c518`). Note the existing overlay/admin already lean gold for the points cell (`#f5c518`) — the new palette's `--gold-primary`/`--gold-light` are a deliberate, closely-related refinement of that existing choice, not an unrelated new color.

---

## 8. Implementation phases

1. **Copy & rename the project.** Copy `C:\Padel\PadelTool\*` (excluding `.git\`, `bin\`, `obj\`) into `C:\Padel\FipGoldBucharest\`. Rename `PadelTool.csproj` → `FipGoldBucharest.csproj`; update `AssemblyName`/`AssemblyTitle`/`Product`/`RootNamespace` to `FipGoldBucharest`. Project-wide find/replace `ObsReplayController` → `FipGoldBucharest` (namespaces, `x:Class`, the two mutex/event-name string literals in `App.xaml.cs`, the AppData folder literals in `SettingsService.cs`/`ScoreboardServerService.cs`, the WebView2 user-data folder literal in `MainWindow.xaml.cs:803`). Update `Title="Padel Tool"` (`MainWindow.xaml:5`) → `"FIP Gold Bucharest 2026"`. New `app.ico` is optional/nice-to-have.
2. **Strip replay** — delete `Services\ObsWebSocketClient.cs`; apply every deletion in §3.1/§2.3 to `MainWindow.xaml`/`MainWindow.xaml.cs`; apply the `ScoreboardServerService.cs`/`AppSettings.cs` deletions in §2.4/§2.7; delete the `replay` case in `server.js` and the footer button in `mobile.html`/`mobile.js`.
3. **Scoring engine + data model** — in `scoring.js`: flip the `deuceMode` default to `'star'`; extend `teams[i].players` to `{name,country}` objects; add `servingPlayer`, `teams_registry` to `createDefaultState()`; add the 4 new command types to `MUTATING` and to the `applyCommand` reducer (§4.3). In `server.js`: add `teams.json` loading + the `teams_registry` hydration merge in `loadState()`; add `GET /api/teams`.
4. **Ship `teams.json`** at `Scoreboard\data\teams.json` using the full content in §11.
5. **Flags** — vendor the 30 SVGs from a permissively-licensed flag set into `Scoreboard\public\flags\` per §5's mapping table; add the shared `ISO3_TO_ISO2` lookup (new `countries.js` or inline in `overlay.js`/`teams.js`).
6. **Admin panel rework** (`admin.html`/`admin.js`/`admin.css`) — delete the left column and the Match-format card; replace the Teams card with the two team-picker dropdowns (§6.2) wired to `GET /api/teams` + `selectTeam`; fix the 13 mojibake spots (§2.8) while retyping this file's markup anyway (labels stay English).
7. **New Teams tab web page** — `teams.html`/`teams.js` (§6.3) + the matching WPF `TabItem`/`WebView2` wiring in `MainWindow.xaml`/`.cs` (copy the `ScoreboardWebView` pattern).
8. **Serve control** — add `setServingPlayer`/`swapServingPlayer` UI to `mobile.html`/`mobile.js` (§6.5); since Tab 1 mirrors `/mobile` verbatim, no separate WPF work is needed there.
9. **Overlay redesign** — rewrite `overlay.html`'s `.board` markup to 4 player-rows + team-number + flags (§6.4); update `overlay.js`'s `render()`/`renderSets()` for the new DOM and per-player serve dot; rewrite `overlay.css` for the new layout and the new palette.
10. **Retheme** — apply §7's palette to `App.xaml`, `admin.css`, `mobile.css`, `overlay.css`.
11. **Encoding verification pass** (the Romanian translation was dropped — labels stay English) — save every touched file as plain UTF-8 without BOM, verified by re-opening and diffing rather than trusting the editor's default save encoding (the whole point of avoiding a repeat of the `admin.html` bug, §2.8/§10).
12. **Testing** — see §9.

---

## 9. Testing checklist

- [ ] `dotnet build -c Release` succeeds with zero references to `ObsReplayController`, `ObsWebSocketClient`, or any `Replay*`/`Obs*` member remaining (a project-wide search for `Replay` and `Obs` after the strip should only match `Scoreboard` npm package's old name in comments, if anything).
- [ ] App launches, single-instance mutex works under the new name (launch twice, second instance should activate the first instead of opening a second window).
- [ ] Tab 1 (Home) shows the embedded `/mobile` page with live score, no replay button visible anywhere.
- [ ] Tab 2 (Score settings): server start/stop, port change, both URL copy buttons; the "Match" picker lists all active teams grouped by category/section with correct flags+names; picking a team on each side updates the live preview and the overlay within ~1s.
- [ ] Tab 3 (Teams): every one of the 89 teams from §11 appears, correctly grouped; toggling a team to "Eliminated" immediately greys it out / removes it from Tab 2's picker dropdowns; the setting survives an app restart (persisted in `scoreboard-state.json`).
- [ ] **OBS Browser Source check**: add the overlay URL as a Browser Source at 1920×1080 in an actual OBS instance; confirm transparent background, 4 player rows with correct flags, correct gold/white score columns, and the green serve dot moves correctly when serve is changed from the operator or referee side.
- [ ] **Phone test on LAN**: open the `/mobile` URL shown in the app on an actual phone on the same Wi-Fi (not localhost); confirm scoring, undo/redo, save/undo set, and both serve controls (team + player) all reach the overlay in real time; confirm no replay button appears anywhere on the phone page.
- [ ] **State persistence**: score a few points, set a team, toggle an elimination, close the app, relaunch — score, team selection, and elimination flags should all be exactly as left (`%AppData%\FipGoldBucharest\scoreboard-state.json`).
- [ ] **Eliminated-team filtering**: eliminate a team that is currently selected as Side 1 or Side 2 for the live match — confirm the app doesn't crash and decide/verify the intended behavior (recommendation: leave the currently-selected match alone even if a side becomes "eliminated" mid-display, since a live match in progress should finish; only filter the *picker* dropdown, not force-clear an in-progress selection).
- [ ] Star/golden-point rule: manually play out a game to 40-40, confirm advantage plays out twice (labels `D1`, `Ad1`, back to `D2`... — actually per engine logic: `D1` at 3-3/40-40, `Ad`/`40` for the first advantage, `D2` at 4-4, `Ad`/`40` for the second advantage, then `GP` at 5-5) and the 3rd deuce becomes sudden death (`GP`), matching `starDeuceLimit: 3`.
- [ ] Best-of-3, 7-point tiebreak at 6-6 win-by-2: play a set to 6-6, confirm a tiebreak starts and needs 7 points with a 2-point margin to end it.
- [ ] Every label reads correctly (no `â€”`/`Â·`/mojibake, no `?` boxes) in `admin.html`, `mobile.html`, `overlay.html`, and in the WPF window itself — re-open each saved file in a hex viewer or `Format-Hex` spot-check to confirm no stray BOM/double-encoding was reintroduced.
- [ ] Window title and taskbar/tray tooltip read "FIP Gold Bucharest 2026" (or the app's decided short name) everywhere `"Padel Tool"` used to appear.

---

## 10. Assumptions to confirm with the user

> **Status (2026-09-01):** items 1, 3, 4 and 10 are CONFIRMED — see "Confirmed decisions" at the top of this file. The remaining items proceed on the recommendations stated below unless the user says otherwise. Item 4 was further refined by a second user screenshot: completed sets render as full-height blue columns (§6.4), not small boxes.

1. **Golden-point rule mapping (high confidence, but confirm)**: the brief's "star point (2 deuce an the golden point)" is interpreted as the scoring engine's existing `deuceMode: 'star'` with `starDeuceLimit: 3` — i.e., advantage is played at the first deuce (40-40) and the second deuce (4-4), and the third deuce (5-5) is decided by a single sudden-death "golden" point. This is not a guess invented for this plan: it matches the engine's own doc comment almost verbatim, and the most recent commit in the PadelTool repo is literally titled "fix Star point to two advantages then sudden death." Recommend proceeding on this basis unless the user specifies a different deuce count.
2. **Match format is one fixed ruleset for the whole tournament, men and women alike** — this follows directly from the brief's own wording ("Fixed format for the whole tournament") and isn't really in question; noted here only for completeness.
3. **Final (3rd) set behavior is unspecified** — the brief says "best of 3 sets" but doesn't say whether the deciding 3rd set is played as a normal set (to 6, tiebreak at 6-6, same as sets 1-2) or as a 10-point super-tiebreak instead of a full set. Recommendation: `finalSetMode: 'normal'` (matches today's default, most traditional) — confirm.
4. **Sets/games column semantics in the scorebug — resolved, not actually open**: the brief's screenshot description hedges ("the games/sets figure") but also explicitly instructs to "keep whatever set columns exist" from the current overlay. Since the current overlay already tracks *both* completed-set history (`.sets`) and current-set games (`.games`) as separate elements, this plan keeps both: the reference screenshot's single gold number is mapped to **current games in the set** (`state.games[i]`), with the existing completed-set-history boxes kept alongside, restyled (§6.4). Flagged here so the user can correct the mapping if the intent was different (e.g., gold = sets won, not games).
5. **Per-player flags for mixed-nationality pairs — resolved, not actually open**: because each of the 4 overlay rows is one individual player with their own `country` field (not one flag per team), mixed pairs (e.g., men's main draw #8, ARG/MEX) are handled automatically with no extra logic.
6. **Removing the entire left column of `admin.html` (Live preview + Scoring + Manual adjust), not just the "Scoring" card literally named in the brief** — genuinely open. The brief says "REMOVE the 'Scoring' area (manual score correction already exists on tab 1)"; this plan's recommendation is to remove all three left-column cards since "Manual adjust" and the live preview are equally redundant with Tab 1's embedded `/mobile` page, for a cleaner Score-settings tab. Confirm before implementing, since a narrower reading (delete only the card literally titled "Scoring") is also defensible.
7. **Overlay light/dark theme toggle** — the brief pins the overlay to the FIP navy/gold look; this plan recommends dropping (or just not exposing) the existing dark/light theme toggle in "Overlay display" since a light theme doesn't fit a fixed tournament brand. Confirm whether to keep it dormant for flexibility or remove it outright.
8. **`servingPlayer` reset behavior** — this plan resets `state.servingPlayer` to `0` whenever `setServer`/`swapServer` changes which team serves. An alternative is to remember each team's last-used serving player independently. Confirm the simpler default is acceptable.
9. **Eliminated-team UX**: "excluded (or greyed out)" was left as an either/or in the brief. This plan recommends greyed-out-and-disabled (visible but not selectable) in both the Teams tab and the match-picker dropdowns, rather than fully hidden, so the operator can still see the whole bracket. Confirm.
10. **The "Romanian mojibake" premise doesn't match the source project — important, please confirm intent.** Every label in the current `PadelTool` codebase, in every file, is English. The only actual encoding corruption found (§2.8) is in `admin.html` alone, and it's corrupted *English* punctuation/emoji (em dash, ellipsis, arrows, a checkmark, middle dots, curly quotes, 🎾) — not Romanian diacritics; no Romanian text, correct or corrupted, exists anywhere in the checked-out source. This plan therefore treats the work as **two separate things**: (a) fix the 13 genuine mojibake spots in `admin.html` (a mechanical retype, §2.8), and (b) **newly translate** every user-facing English label to Romanian as part of building the new app, taking care to save every touched file as clean UTF-8 (no BOM needed, since `<meta charset="UTF-8">` is already declared) so the same double-encoding accident isn't reintroduced. If the user was thinking of a different/newer copy of the project with real Romanian text, that copy should be located and re-diffed before starting, since this plan's specific fix-list (§2.8) is based on what's actually in `C:\Padel\PadelTool` today.
11. **Legacy hardcoded strings** — decide whether to keep or drop the legacy Node-bundle fallback path `C:\Padel\ObsPadelScoreBoard\.node` in `ScoreboardServerService.FindNodeExe` (harmless to keep as an extra fallback; arguably dead weight for a fresh project) and whether the tray/mutex naming should reference "FipGoldBucharest" or something shorter for internal strings (doesn't affect user-visible behavior either way).
12. **`ChkMinimizeToTray` relocation** — confirm where this single surviving general setting should live in the new 3-tab layout (candidates: a small icon/menu near the tray icon with no dedicated tab control, or a compact "app settings" strip on the Home tab).

---

## 11. Appendix — full extracted team lists (`teams.json`)

Source: `Entry-List-Fip-Gold-Bucharest-M-V3-1.pdf` (men, "Last Update: 31/8/2026 05:40 pm") and `Entry-List-Fip-Gold-Bucharest-W.pdf` (women, "Last Update: 30/8/2026 12:20 pm"), both from `C:\Users\crapa\Downloads`. Every pair with an actual player name is included below — **89 teams, 178 players**: men 58 (28 main draw + 30 qualifying), women 31 (26 main draw + 5 qualifying as printed). **Update 2026-09-04:** per the user, all five women's qualifying pairs play in the main draw — they were moved in `teams.json` to `section: "main_draw"` as `W-MD-27`…`W-MD-31` (positions 27–31); the women's qualifying group is now empty (the appendix below still shows the original PDF split). Unfilled reserve/wildcard/alternate-wildcard slots that carry no player names (14 in men's qualifying, 2 in women's main draw, 11 in women's qualifying — 27 total) are intentionally omitted since there is no player data to record; re-check the live FIP entry list closer to the tournament in case any of those slots fill in.

This file is validated JSON (parsed and count-checked with `ConvertFrom-Json`: 89 teams, 178 players, all with exactly 2 players, no duplicate `id`s, 30 distinct country codes matching §5's mapping table exactly).

```json
{
  "tournament": "FIP Gold Bucharest 2026",
  "source": {
    "men": "Entry-List-Fip-Gold-Bucharest-M-V3-1.pdf (Last Update: 31/8/2026 05:40 pm)",
    "women": "Entry-List-Fip-Gold-Bucharest-W.pdf (Last Update: 30/8/2026 12:20 pm)"
  },
  "teams": [
    { "id": "M-MD-01", "category": "men", "section": "main_draw", "position": 1, "wildcard": false, "active": true, "teamPoints": 3213,
      "players": [ { "name": "Enzo Jensen Sirvent", "country": "ITA", "ranking": 47, "rankingPoints": 1278 }, { "name": "David Gala", "country": "ESP", "ranking": 34, "rankingPoints": 1935 } ] },
    { "id": "M-MD-02", "category": "men", "section": "main_draw", "position": 2, "wildcard": false, "active": true, "teamPoints": 2544,
      "players": [ { "name": "Francisco Manuel Gil Morales", "country": "ESP", "ranking": 61, "rankingPoints": 1044 }, { "name": "Pablo Lijó", "country": "ESP", "ranking": 41, "rankingPoints": 1500 } ] },
    { "id": "M-MD-03", "category": "men", "section": "main_draw", "position": 3, "wildcard": false, "active": true, "teamPoints": 2387,
      "players": [ { "name": "Mariano Agustin Gonzalez San Martin", "country": "PAR", "ranking": 55, "rankingPoints": 1161 }, { "name": "Francisco Cabeza Teres", "country": "ESP", "ranking": 49, "rankingPoints": 1226 } ] },
    { "id": "M-MD-04", "category": "men", "section": "main_draw", "position": 4, "wildcard": false, "active": true, "teamPoints": 2068,
      "players": [ { "name": "Denis Tomas Perino", "country": "ITA", "ranking": 59, "rankingPoints": 1063 }, { "name": "Andres Fernandez Lancha", "country": "ESP", "ranking": 64, "rankingPoints": 1005 } ] },
    { "id": "M-MD-05", "category": "men", "section": "main_draw", "position": 5, "wildcard": false, "active": true, "teamPoints": 1607,
      "players": [ { "name": "Alvaro Cepero", "country": "ESP", "ranking": 51, "rankingPoints": 1180 }, { "name": "Pepe Aliaga", "country": "ESP", "ranking": 138, "rankingPoints": 427 } ] },
    { "id": "M-MD-06", "category": "men", "section": "main_draw", "position": 6, "wildcard": false, "active": true, "teamPoints": 1501,
      "players": [ { "name": "Ignacio Sager", "country": "ESP", "ranking": 76, "rankingPoints": 861 }, { "name": "Salva Oria", "country": "ESP", "ranking": 99, "rankingPoints": 640 } ] },
    { "id": "M-MD-07", "category": "men", "section": "main_draw", "position": 7, "wildcard": false, "active": true, "teamPoints": 1253,
      "players": [ { "name": "Manuel Aragon Herrera", "country": "ESP", "ranking": 110, "rankingPoints": 569 }, { "name": "Albert Roglan Pons", "country": "ESP", "ranking": 94, "rankingPoints": 684 } ] },
    { "id": "M-MD-08", "category": "men", "section": "main_draw", "position": 8, "wildcard": false, "active": true, "teamPoints": 1201,
      "players": [ { "name": "Agustín Torre", "country": "ARG", "ranking": 77, "rankingPoints": 852 }, { "name": "Diego Arredondo García", "country": "MEX", "ranking": 165, "rankingPoints": 349 } ] },
    { "id": "M-MD-09", "category": "men", "section": "main_draw", "position": 9, "wildcard": false, "active": true, "teamPoints": 1149,
      "players": [ { "name": "Guillem Figuerola Santiago", "country": "ESP", "ranking": 110, "rankingPoints": 569 }, { "name": "Roberto Belmont Pastor", "country": "ESP", "ranking": 109, "rankingPoints": 580 } ] },
    { "id": "M-MD-10", "category": "men", "section": "main_draw", "position": 10, "wildcard": false, "active": true, "teamPoints": 1119,
      "players": [ { "name": "Gustavo Nunes", "country": "POR", "ranking": 140, "rankingPoints": 421 }, { "name": "Anton Sans", "country": "ESP", "ranking": 91, "rankingPoints": 698 } ] },
    { "id": "M-MD-11", "category": "men", "section": "main_draw", "position": 11, "wildcard": false, "active": true, "teamPoints": 948,
      "players": [ { "name": "Victor Mena", "country": "ESP", "ranking": 99, "rankingPoints": 640 }, { "name": "Francisco Jurado Sosa", "country": "UAE", "ranking": 180, "rankingPoints": 308 } ] },
    { "id": "M-MD-12", "category": "men", "section": "main_draw", "position": 12, "wildcard": false, "active": true, "teamPoints": 881,
      "players": [ { "name": "Nicolas Zurita", "country": "ITA", "ranking": 129, "rankingPoints": 465 }, { "name": "Simone Cremona", "country": "ITA", "ranking": 141, "rankingPoints": 416 } ] },
    { "id": "M-MD-13", "category": "men", "section": "main_draw", "position": 13, "wildcard": false, "active": true, "teamPoints": 857,
      "players": [ { "name": "Pau Miñano Ortinez", "country": "ESP", "ranking": 133, "rankingPoints": 446 }, { "name": "Boris Castro Garcia", "country": "ESP", "ranking": 142, "rankingPoints": 411 } ] },
    { "id": "M-MD-14", "category": "men", "section": "main_draw", "position": 14, "wildcard": false, "active": true, "teamPoints": 719,
      "players": [ { "name": "Simone Iacovino", "country": "ITA", "ranking": 169, "rankingPoints": 343 }, { "name": "Giulio Graziotti", "country": "ITA", "ranking": 153, "rankingPoints": 376 } ] },
    { "id": "M-MD-15", "category": "men", "section": "main_draw", "position": 15, "wildcard": false, "active": true, "teamPoints": 708,
      "players": [ { "name": "Agustin Reca", "country": "GER", "ranking": 160, "rankingPoints": 355 }, { "name": "Victor Tur Checa", "country": "ESP", "ranking": 162, "rankingPoints": 353 } ] },
    { "id": "M-MD-16", "category": "men", "section": "main_draw", "position": 16, "wildcard": false, "active": true, "teamPoints": 694,
      "players": [ { "name": "José Enrique Giménez Barcelona", "country": "ESP", "ranking": 157, "rankingPoints": 366 }, { "name": "Alejandro Merino Nieto", "country": "ESP", "ranking": 173, "rankingPoints": 328 } ] },
    { "id": "M-MD-17", "category": "men", "section": "main_draw", "position": 17, "wildcard": false, "active": true, "teamPoints": 618,
      "players": [ { "name": "Julien Seurin", "country": "FRA", "ranking": 176, "rankingPoints": 317 }, { "name": "Johan Bergeron", "country": "FRA", "ranking": 183, "rankingPoints": 301 } ] },
    { "id": "M-MD-18", "category": "men", "section": "main_draw", "position": 18, "wildcard": false, "active": true, "teamPoints": 576,
      "players": [ { "name": "Sergio Nieto Simon", "country": "ESP", "ranking": 211, "rankingPoints": 242 }, { "name": "Douglas Rutgersson", "country": "SWE", "ranking": 171, "rankingPoints": 334 } ] },
    { "id": "M-MD-19", "category": "men", "section": "main_draw", "position": 19, "wildcard": false, "active": true, "teamPoints": 501,
      "players": [ { "name": "Juan Manuel Lasgoity", "country": "ITA", "ranking": 207, "rankingPoints": 250 }, { "name": "Santino Giuliani", "country": "ITA", "ranking": 205, "rankingPoints": 251 } ] },
    { "id": "M-MD-20", "category": "men", "section": "main_draw", "position": 20, "wildcard": false, "active": true, "teamPoints": 484,
      "players": [ { "name": "Giuseppe Fino", "country": "ITA", "ranking": 213, "rankingPoints": 233 }, { "name": "Lorenzo Di Giovanni", "country": "ITA", "ranking": 205, "rankingPoints": 251 } ] },
    { "id": "M-MD-21", "category": "men", "section": "main_draw", "position": 21, "wildcard": false, "active": true, "teamPoints": 463,
      "players": [ { "name": "Matteo Sargolini", "country": "ITA", "ranking": 210, "rankingPoints": 243 }, { "name": "Bentahor Espino Mustafa", "country": "ESP", "ranking": 220, "rankingPoints": 220 } ] },
    { "id": "M-MD-22", "category": "men", "section": "main_draw", "position": 22, "wildcard": false, "active": true, "teamPoints": 452,
      "players": [ { "name": "Sergio Tierno Herrero", "country": "ESP", "ranking": 229, "rankingPoints": 196 }, { "name": "Jaime Pérez Martín", "country": "ESP", "ranking": 203, "rankingPoints": 256 } ] },
    { "id": "M-MD-23", "category": "men", "section": "main_draw", "position": 23, "wildcard": false, "active": true, "teamPoints": 396,
      "players": [ { "name": "Simone Vaccari", "country": "ITA", "ranking": 248, "rankingPoints": 167 }, { "name": "Matteo Rosingana", "country": "ITA", "ranking": 217, "rankingPoints": 229 } ] },
    { "id": "M-MD-24", "category": "men", "section": "main_draw", "position": 24, "wildcard": false, "active": true, "teamPoints": 328,
      "players": [ { "name": "Guillermo Fernandez Sanchez", "country": "ESP", "ranking": 201, "rankingPoints": 260 }, { "name": "Lorenzo Bogarin", "country": "ITA", "ranking": 445, "rankingPoints": 68 } ] },
    { "id": "M-MD-25", "category": "men", "section": "main_draw", "position": 25, "wildcard": false, "active": true, "teamPoints": 328,
      "players": [ { "name": "Yanis Muesser", "country": "FRA", "ranking": 266, "rankingPoints": 152 }, { "name": "Arthur Hugounenq", "country": "FRA", "ranking": 239, "rankingPoints": 176 } ] },
    { "id": "M-MD-26", "category": "men", "section": "main_draw", "position": 26, "wildcard": false, "active": true, "teamPoints": 321,
      "players": [ { "name": "Karlos Rodriguez Vidal", "country": "ESP", "ranking": 249, "rankingPoints": 166 }, { "name": "Oscar Sebber Gormsen", "country": "DEN", "ranking": 263, "rankingPoints": 155 } ] },
    { "id": "M-MD-27", "category": "men", "section": "main_draw", "position": 27, "wildcard": true, "active": true, "teamPoints": 46,
      "players": [ { "name": "Horia Vladimir Nedelcu", "country": "ROU", "ranking": 659, "rankingPoints": 35 }, { "name": "Mihnea Petru Zaharia", "country": "ROU", "ranking": 1295, "rankingPoints": 11 } ] },
    { "id": "M-MD-28", "category": "men", "section": "main_draw", "position": 28, "wildcard": true, "active": true, "teamPoints": 28,
      "players": [ { "name": "Armand Baboian", "country": "ROU", "ranking": 1010, "rankingPoints": 17 }, { "name": "Robert Coman", "country": "ROU", "ranking": 1295, "rankingPoints": 11 } ] },

    { "id": "M-Q-01", "category": "men", "section": "qualifying", "position": 1, "wildcard": false, "active": true, "teamPoints": 314,
      "players": [ { "name": "Filippo Nicocia", "country": "ARG", "ranking": 244, "rankingPoints": 170 }, { "name": "Matteo Platania", "country": "ITA", "ranking": 273, "rankingPoints": 144 } ] },
    { "id": "M-Q-02", "category": "men", "section": "qualifying", "position": 2, "wildcard": false, "active": true, "teamPoints": 301,
      "players": [ { "name": "Noa Bonnefoy", "country": "ITA", "ranking": 251, "rankingPoints": 164 }, { "name": "Michele Brambilla", "country": "ITA", "ranking": 279, "rankingPoints": 137 } ] },
    { "id": "M-Q-03", "category": "men", "section": "qualifying", "position": 3, "wildcard": false, "active": true, "teamPoints": 298,
      "players": [ { "name": "Lucas Miranda Santos", "country": "ESP", "ranking": 380, "rankingPoints": 91 }, { "name": "Thomas Vanbauce", "country": "FRA", "ranking": 226, "rankingPoints": 207 } ] },
    { "id": "M-Q-04", "category": "men", "section": "qualifying", "position": 4, "wildcard": false, "active": true, "teamPoints": 297,
      "players": [ { "name": "Noe Navarro Porras", "country": "ESP", "ranking": 236, "rankingPoints": 182 }, { "name": "Exequiel Mouriño", "country": "ARG", "ranking": 324, "rankingPoints": 115 } ] },
    { "id": "M-Q-05", "category": "men", "section": "qualifying", "position": 5, "wildcard": false, "active": true, "teamPoints": 271, "note": "Player 1 surname printed as 'Adrian Rodriguez rodriguez-Manzaneque' in the source PDF (lowercase second element) - likely the compound Spanish surname 'Rodríguez Rodríguez-Manzaneque'; verify against the official source before printing on the overlay.",
      "players": [ { "name": "Adrian Rodriguez Rodriguez-Manzaneque", "country": "ESP", "ranking": 238, "rankingPoints": 179 }, { "name": "David Esteban Esposito", "country": "ESP", "ranking": 377, "rankingPoints": 92 } ] },
    { "id": "M-Q-06", "category": "men", "section": "qualifying", "position": 6, "wildcard": false, "active": true, "teamPoints": 236,
      "players": [ { "name": "Nicolas Peña Ruiz", "country": "ESP", "ranking": 295, "rankingPoints": 130 }, { "name": "Manuel Ramirez Perez", "country": "ESP", "ranking": 344, "rankingPoints": 106 } ] },
    { "id": "M-Q-07", "category": "men", "section": "qualifying", "position": 7, "wildcard": false, "active": true, "teamPoints": 232,
      "players": [ { "name": "Pietro Giovannini", "country": "ITA", "ranking": 478, "rankingPoints": 61 }, { "name": "Federico Galli", "country": "ITA", "ranking": 243, "rankingPoints": 171 } ] },
    { "id": "M-Q-08", "category": "men", "section": "qualifying", "position": 8, "wildcard": false, "active": true, "teamPoints": 223,
      "players": [ { "name": "Giorgio Saputo", "country": "ITA", "ranking": 368, "rankingPoints": 96 }, { "name": "Theodore Garton", "country": "GBR", "ranking": 302, "rankingPoints": 127 } ] },
    { "id": "M-Q-09", "category": "men", "section": "qualifying", "position": 9, "wildcard": false, "active": true, "teamPoints": 191,
      "players": [ { "name": "Rayane Akram Hamou", "country": "ALG", "ranking": 403, "rankingPoints": 79 }, { "name": "Vasileios Sioulis", "country": "GRE", "ranking": 330, "rankingPoints": 112 } ] },
    { "id": "M-Q-10", "category": "men", "section": "qualifying", "position": 10, "wildcard": false, "active": true, "teamPoints": 181,
      "players": [ { "name": "Bohdan Levchuk", "country": "UKR", "ranking": 341, "rankingPoints": 107 }, { "name": "Michal Bartusek", "country": "POL", "ranking": 434, "rankingPoints": 74 } ] },
    { "id": "M-Q-11", "category": "men", "section": "qualifying", "position": 11, "wildcard": false, "active": true, "teamPoints": 73,
      "players": [ { "name": "Catalin Tropin", "country": "MDA", "ranking": 563, "rankingPoints": 45 }, { "name": "Vitalie Sciuca", "country": "MDA", "ranking": 756, "rankingPoints": 28 } ] },
    { "id": "M-Q-12", "category": "men", "section": "qualifying", "position": 12, "wildcard": false, "active": true, "teamPoints": 64,
      "players": [ { "name": "Jakub Strapek", "country": "SVK", "ranking": 729, "rankingPoints": 30 }, { "name": "Walter Ihring", "country": "SVK", "ranking": 675, "rankingPoints": 34 } ] },
    { "id": "M-Q-13", "category": "men", "section": "qualifying", "position": 13, "wildcard": false, "active": true, "teamPoints": 47,
      "players": [ { "name": "Rio Hanif", "country": "GBR", "ranking": 1127, "rankingPoints": 14 }, { "name": "Lasse Schramm Simonsen", "country": "DEN", "ranking": 689, "rankingPoints": 33 } ] },
    { "id": "M-Q-14", "category": "men", "section": "qualifying", "position": 14, "wildcard": false, "active": true, "teamPoints": 41,
      "players": [ { "name": "Witold Konopko", "country": "POL", "ranking": 626, "rankingPoints": 38 }, { "name": "Przemyslaw Zalubski", "country": "POL", "ranking": 2362, "rankingPoints": 3 } ] },
    { "id": "M-Q-15", "category": "men", "section": "qualifying", "position": 15, "wildcard": false, "active": true, "teamPoints": 37,
      "players": [ { "name": "Younis Al Rawahi", "country": "OMA", "ranking": 1517, "rankingPoints": 8 }, { "name": "Rayyan Abdulla", "country": "QAT", "ranking": 741, "rankingPoints": 29 } ] },
    { "id": "M-Q-16", "category": "men", "section": "qualifying", "position": 16, "wildcard": false, "active": true, "teamPoints": 29,
      "players": [ { "name": "Dinu Serbanescu", "country": "ROU", "ranking": 1039, "rankingPoints": 16 }, { "name": "Robert Florin Popescu", "country": "ROU", "ranking": 1176, "rankingPoints": 13 } ] },
    { "id": "M-Q-17", "category": "men", "section": "qualifying", "position": 17, "wildcard": false, "active": true, "teamPoints": 17,
      "players": [ { "name": "Dominik Durlin", "country": "CZE", "ranking": 1375, "rankingPoints": 10 }, { "name": "Pavel Dinh", "country": "CZE", "ranking": 1728, "rankingPoints": 7 } ] },
    { "id": "M-Q-18", "category": "men", "section": "qualifying", "position": 18, "wildcard": false, "active": true, "teamPoints": 5,
      "players": [ { "name": "Dan Alexandru Tomescu", "country": "ROU", "ranking": 1938, "rankingPoints": 5 }, { "name": "Denis Adrian Mocanu", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-19", "category": "men", "section": "qualifying", "position": 19, "wildcard": false, "active": true, "teamPoints": 5,
      "players": [ { "name": "Bogdan-Alin Bristan", "country": "ROU", "ranking": 1938, "rankingPoints": 5 }, { "name": "Radu Arnăutu", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-20", "category": "men", "section": "qualifying", "position": 20, "wildcard": false, "active": true, "teamPoints": 4,
      "players": [ { "name": "Emil-Mihai Bront", "country": "ROU", "ranking": 2915, "rankingPoints": 2 }, { "name": "Horia Alexandru Matei", "country": "ROU", "ranking": 2915, "rankingPoints": 2 } ] },
    { "id": "M-Q-21", "category": "men", "section": "qualifying", "position": 21, "wildcard": false, "active": true, "teamPoints": 4,
      "players": [ { "name": "Kazmer Zoltan Tussai", "country": "ROU", "ranking": 2915, "rankingPoints": 2 }, { "name": "Lorand Tussai", "country": "ROU", "ranking": 2915, "rankingPoints": 2 } ] },
    { "id": "M-Q-22", "category": "men", "section": "qualifying", "position": 22, "wildcard": false, "active": true, "teamPoints": 4,
      "players": [ { "name": "Mihnea Ghiurca Anton", "country": "ROU", "ranking": 2915, "rankingPoints": 2 }, { "name": "Andreas Niemersheim", "country": "ROU", "ranking": 2915, "rankingPoints": 2 } ] },
    { "id": "M-Q-23", "category": "men", "section": "qualifying", "position": 23, "wildcard": false, "active": true, "teamPoints": 3, "note": "Player 1 shares the operator's own name - coincidental source data, no special handling needed.",
      "players": [ { "name": "Mihai Crapatureanu", "country": "ROU", "ranking": 2362, "rankingPoints": 3 }, { "name": "Kaan Sali", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-24", "category": "men", "section": "qualifying", "position": 24, "wildcard": false, "active": true, "teamPoints": 3,
      "players": [ { "name": "Alexe Bucur", "country": "ROU", "ranking": 2362, "rankingPoints": 3 }, { "name": "Alexandru Cristian Dumitru", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-25", "category": "men", "section": "qualifying", "position": 25, "wildcard": false, "active": true, "teamPoints": 3,
      "players": [ { "name": "Mark Konjar", "country": "SLO", "ranking": 2362, "rankingPoints": 3 }, { "name": "Jure Tozon", "country": "SLO", "ranking": 3250, "rankingPoints": 0 } ] },
    { "id": "M-Q-26", "category": "men", "section": "qualifying", "position": 26, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Claudiu Alexandru Baluta", "country": "ROU", "ranking": null, "rankingPoints": 0 }, { "name": "Razvan Popsor", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-27", "category": "men", "section": "qualifying", "position": 27, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Henock Mukendi Kankolongo", "country": "COD", "ranking": null, "rankingPoints": 0 }, { "name": "Glody Kabangu Kankolongo", "country": "COD", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-28", "category": "men", "section": "qualifying", "position": 28, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Sabau Dragos Stefan", "country": "ROU", "ranking": null, "rankingPoints": 0 }, { "name": "Eduard Stanciu", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-29", "category": "men", "section": "qualifying", "position": 29, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Pena Radu", "country": "ROU", "ranking": null, "rankingPoints": 0 }, { "name": "Adochitei Pandelea Eric Tudor", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "M-Q-30", "category": "men", "section": "qualifying", "position": 30, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Alexandru Buzaianu", "country": "ROU", "ranking": null, "rankingPoints": 0 }, { "name": "Cristian Iordan", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },

    { "id": "W-MD-01", "category": "women", "section": "main_draw", "position": 1, "wildcard": false, "active": true, "teamPoints": 3035,
      "players": [ { "name": "Lucia Martinez Gomez", "country": "ESP", "ranking": 38, "rankingPoints": 1620 }, { "name": "Letizia Maria Manquillo Alarza", "country": "ESP", "ranking": 43, "rankingPoints": 1415 } ] },
    { "id": "W-MD-02", "category": "women", "section": "main_draw", "position": 2, "wildcard": false, "active": true, "teamPoints": 3017,
      "players": [ { "name": "Araceli Martinez", "country": "ESP", "ranking": 36, "rankingPoints": 1657 }, { "name": "Laura Luján Rodríguez", "country": "ESP", "ranking": 45, "rankingPoints": 1360 } ] },
    { "id": "W-MD-03", "category": "women", "section": "main_draw", "position": 3, "wildcard": false, "active": true, "teamPoints": 2385,
      "players": [ { "name": "Ariadna Cañellas Rodero", "country": "ESP", "ranking": 58, "rankingPoints": 1116 }, { "name": "Patricia Martinez Fortun", "country": "ESP", "ranking": 50, "rankingPoints": 1269 } ] },
    { "id": "W-MD-04", "category": "women", "section": "main_draw", "position": 4, "wildcard": false, "active": true, "teamPoints": 1964,
      "players": [ { "name": "Marta Arellano Navarro", "country": "ESP", "ranking": 68, "rankingPoints": 789 }, { "name": "Marina Lobo", "country": "ESP", "ranking": 56, "rankingPoints": 1175 } ] },
    { "id": "W-MD-05", "category": "women", "section": "main_draw", "position": 5, "wildcard": false, "active": true, "teamPoints": 1661,
      "players": [ { "name": "Sandra Bellver Fructuoso", "country": "ESP", "ranking": 65, "rankingPoints": 874 }, { "name": "Ana Dominguez Gracia", "country": "ESP", "ranking": 69, "rankingPoints": 787 } ] },
    { "id": "W-MD-06", "category": "women", "section": "main_draw", "position": 6, "wildcard": false, "active": true, "teamPoints": 1648,
      "players": [ { "name": "Aida Martinez", "country": "ESP", "ranking": 64, "rankingPoints": 876 }, { "name": "Natividad Lopez Diaz", "country": "ESP", "ranking": 72, "rankingPoints": 772 } ] },
    { "id": "W-MD-07", "category": "women", "section": "main_draw", "position": 7, "wildcard": false, "active": true, "teamPoints": 1361,
      "players": [ { "name": "Brittany Dubins", "country": "USA", "ranking": 79, "rankingPoints": 685 }, { "name": "Camila Ramme Coellar", "country": "MEX", "ranking": 82, "rankingPoints": 676 } ] },
    { "id": "W-MD-08", "category": "women", "section": "main_draw", "position": 8, "wildcard": false, "active": true, "teamPoints": 1258,
      "players": [ { "name": "Carlotta Casali Vannicelli", "country": "ITA", "ranking": 81, "rankingPoints": 677 }, { "name": "Clarissa Margherita Aima", "country": "ITA", "ranking": 88, "rankingPoints": 581 } ] },
    { "id": "W-MD-09", "category": "women", "section": "main_draw", "position": 9, "wildcard": false, "active": true, "teamPoints": 1225,
      "players": [ { "name": "Ana Varo Ramos", "country": "ESP", "ranking": 94, "rankingPoints": 514 }, { "name": "Marcella Koek", "country": "NED", "ranking": 77, "rankingPoints": 711 } ] },
    { "id": "W-MD-10", "category": "women", "section": "main_draw", "position": 10, "wildcard": false, "active": true, "teamPoints": 1213,
      "players": [ { "name": "Alba Perez Momha", "country": "ESP", "ranking": 67, "rankingPoints": 792 }, { "name": "Alba Gallardo Salvado", "country": "ESP", "ranking": 110, "rankingPoints": 421 } ] },
    { "id": "W-MD-11", "category": "women", "section": "main_draw", "position": 11, "wildcard": false, "active": true, "teamPoints": 482,
      "players": [ { "name": "Bruna Albuquerque Melo", "country": "POR", "ranking": 148, "rankingPoints": 244 }, { "name": "Lorena Alonso De Lera", "country": "ESP", "ranking": 151, "rankingPoints": 238 } ] },
    { "id": "W-MD-12", "category": "women", "section": "main_draw", "position": 12, "wildcard": false, "active": true, "teamPoints": 376,
      "players": [ { "name": "Martina Vera Cebollero", "country": "ESP", "ranking": 158, "rankingPoints": 220 }, { "name": "Mar Munera Vila", "country": "ESP", "ranking": 186, "rankingPoints": 156 } ] },
    { "id": "W-MD-13", "category": "women", "section": "main_draw", "position": 13, "wildcard": false, "active": true, "teamPoints": 362,
      "players": [ { "name": "Ainhoa Navarro Fernandez", "country": "ESP", "ranking": 199, "rankingPoints": 140 }, { "name": "Francesca Ligotti", "country": "ITA", "ranking": 157, "rankingPoints": 222 } ] },
    { "id": "W-MD-14", "category": "women", "section": "main_draw", "position": 14, "wildcard": false, "active": true, "teamPoints": 315,
      "players": [ { "name": "Manon Marcarie", "country": "FRA", "ranking": 175, "rankingPoints": 181 }, { "name": "Cassandra Senjean", "country": "FRA", "ranking": 205, "rankingPoints": 134 } ] },
    { "id": "W-MD-15", "category": "women", "section": "main_draw", "position": 15, "wildcard": false, "active": true, "teamPoints": 305,
      "players": [ { "name": "Aurora Buscaino", "country": "ITA", "ranking": 189, "rankingPoints": 154 }, { "name": "Leire Uriarte Medina", "country": "ESP", "ranking": 193, "rankingPoints": 151 } ] },
    { "id": "W-MD-16", "category": "women", "section": "main_draw", "position": 16, "wildcard": false, "active": true, "teamPoints": 286,
      "players": [ { "name": "Lisa Rachel Phillips", "country": "GBR", "ranking": 181, "rankingPoints": 164 }, { "name": "Abigail Tordoff", "country": "GBR", "ranking": 208, "rankingPoints": 122 } ] },
    { "id": "W-MD-17", "category": "women", "section": "main_draw", "position": 17, "wildcard": false, "active": true, "teamPoints": 278,
      "players": [ { "name": "Lea Jurković", "country": "CRO", "ranking": 223, "rankingPoints": 110 }, { "name": "Luna Di Battista", "country": "ITA", "ranking": 180, "rankingPoints": 168 } ] },
    { "id": "W-MD-18", "category": "women", "section": "main_draw", "position": 18, "wildcard": false, "active": true, "teamPoints": 226,
      "players": [ { "name": "Clara Miret Llorach", "country": "ESP", "ranking": 222, "rankingPoints": 111 }, { "name": "Camilla Ronchini", "country": "ITA", "ranking": 217, "rankingPoints": 115 } ] },
    { "id": "W-MD-19", "category": "women", "section": "main_draw", "position": 19, "wildcard": false, "active": true, "teamPoints": 219,
      "players": [ { "name": "Michela Zaccagnini", "country": "ITA", "ranking": 219, "rankingPoints": 113 }, { "name": "Giuditta Beltrami", "country": "ITA", "ranking": 227, "rankingPoints": 106 } ] },
    { "id": "W-MD-20", "category": "women", "section": "main_draw", "position": 20, "wildcard": false, "active": true, "teamPoints": 199,
      "players": [ { "name": "Sandra Martinez Diaz", "country": "ESP", "ranking": 231, "rankingPoints": 102 }, { "name": "Helena Rousselet Novillo", "country": "BRA", "ranking": 242, "rankingPoints": 97 } ] },
    { "id": "W-MD-21", "category": "women", "section": "main_draw", "position": 21, "wildcard": false, "active": true, "teamPoints": 194,
      "players": [ { "name": "Carla Rodriguez Sanchez", "country": "USA", "ranking": 426, "rankingPoints": 38 }, { "name": "Martina Minetti", "country": "FIN", "ranking": 186, "rankingPoints": 156 } ] },
    { "id": "W-MD-22", "category": "women", "section": "main_draw", "position": 22, "wildcard": false, "active": true, "teamPoints": 187,
      "players": [ { "name": "Rosie Quirk", "country": "GBR", "ranking": 289, "rankingPoints": 75 }, { "name": "Laura Jackson", "country": "GBR", "ranking": 221, "rankingPoints": 112 } ] },
    { "id": "W-MD-23", "category": "women", "section": "main_draw", "position": 23, "wildcard": false, "active": true, "teamPoints": 176,
      "players": [ { "name": "Nina Duernberger", "country": "AUT", "ranking": 281, "rankingPoints": 78 }, { "name": "Anna Schmid", "country": "AUT", "ranking": 240, "rankingPoints": 98 } ] },
    { "id": "W-MD-24", "category": "women", "section": "main_draw", "position": 24, "wildcard": false, "active": true, "teamPoints": 152,
      "players": [ { "name": "Carmen Ibañez Diaz", "country": "ESP", "ranking": 261, "rankingPoints": 84 }, { "name": "Giulia Pisano", "country": "ITA", "ranking": 310, "rankingPoints": 68 } ] },
    { "id": "W-MD-25", "category": "women", "section": "main_draw", "position": 25, "wildcard": false, "active": true, "teamPoints": 83,
      "players": [ { "name": "Inés Muñoz Escudero", "country": "ESP", "ranking": 1228, "rankingPoints": 5 }, { "name": "Radu Alice", "country": "ROU", "ranking": 281, "rankingPoints": 78 } ] },
    { "id": "W-MD-26", "category": "women", "section": "main_draw", "position": 26, "wildcard": false, "active": true, "teamPoints": 82,
      "players": [ { "name": "Alina Yeroshenko", "country": "UKR", "ranking": 328, "rankingPoints": 61 }, { "name": "Yuliya Hoske", "country": "UKR", "ranking": 601, "rankingPoints": 21 } ] },

    { "id": "W-Q-01", "category": "women", "section": "qualifying", "position": 1, "wildcard": false, "active": true, "teamPoints": 61,
      "players": [ { "name": "Elisa Sararu", "country": "ROU", "ranking": 468, "rankingPoints": 32 }, { "name": "Cristina Aiello", "country": "ROU", "ranking": 496, "rankingPoints": 29 } ] },
    { "id": "W-Q-02", "category": "women", "section": "qualifying", "position": 2, "wildcard": false, "active": true, "teamPoints": 45,
      "players": [ { "name": "Naicu Giulia Roberta Maria", "country": "ROU", "ranking": 601, "rankingPoints": 21 }, { "name": "Nereida Quero Jiménez", "country": "ESP", "ranking": 555, "rankingPoints": 24 } ] },
    { "id": "W-Q-03", "category": "women", "section": "qualifying", "position": 3, "wildcard": false, "active": true, "teamPoints": 18,
      "players": [ { "name": "Roxana Jianu", "country": "ROU", "ranking": 939, "rankingPoints": 10 }, { "name": "Ilinca Irimia", "country": "ROU", "ranking": 1000, "rankingPoints": 8 } ] },
    { "id": "W-Q-04", "category": "women", "section": "qualifying", "position": 4, "wildcard": false, "active": true, "teamPoints": 5,
      "players": [ { "name": "Alice Tartaglia", "country": "ITA", "ranking": 1228, "rankingPoints": 5 }, { "name": "Raluca Elena Ciufrila", "country": "ROU", "ranking": null, "rankingPoints": 0 } ] },
    { "id": "W-Q-05", "category": "women", "section": "qualifying", "position": 5, "wildcard": false, "active": true, "teamPoints": 0,
      "players": [ { "name": "Vlada Caraulnaia", "country": "MDA", "ranking": null, "rankingPoints": 0 }, { "name": "Daniela Garstea", "country": "MDA", "ranking": null, "rankingPoints": 0 } ] }
  ],
  "unfilled_reserved_slots": {
    "men_qualifying_wc_awc": 14,
    "women_main_draw_wc": 2,
    "women_qualifying_wc_awc": 11
  }
}
```

---

## 12. Phase 2 — Court TV page + automatic commercial breaks (planned 2026-09-02)

Two new features requested after the initial release. Nothing below is implemented yet.

### 12.1 Feature A — full-screen court TV score page (`/tv`)

**Goal:** a page showing *only* the score — same content and column semantics as the OBS scorebug (flags, player names, serve dot, blue completed sets, gold current-set games, white points, winner banner) — but scaled to fill the whole browser window on a solid **black** background. Intended for a TV / monitor / laptop at the court, opened over LAN on any device.

**New files** (reuse `scoring.js`, `countries.js`, `client.js` exactly like the overlay does):

| File | Purpose |
|---|---|
| `Scoreboard\public\tv.html` | page skeleton: 2 team blocks × 2 player rows + score columns + winner banner |
| `Scoreboard\public\tv.css` | black `#000` background; all sizes in viewport units (`vw`/`vh` with `clamp()`) so the board fills the screen edge-to-edge at any resolution; landscape 16:9 is the primary target, but it must stay usable in portrait (stacked, smaller) |
| `Scoreboard\public\tv.js` | a variant of `overlay.js`'s `render()` — same state → DOM mapping, no `?pos=/?scale=` handling (always full-viewport) |

**Server changes** (`server.js`):
- Route: `/tv` → `tv.html`.
- New `GET /api/info` → `{ port, lanHost }` (reuse the existing `firstLanAddress()`), because the admin page is often viewed via `127.0.0.1` inside the WPF WebView — it cannot derive the LAN URL from `location.origin`, and the TV is another device.

**Admin panel** (`admin.html`/`admin.js`): a new small card **"Court TV display"** directly under "OBS overlay URL": a read-only URL `http://{lanHost}:{port}/tv` + **Copy** and **Open** buttons (same pattern as the overlay URL row).

**Behavior details:**
- Identical live semantics to the overlay, including the finished-match collapse (blue sets + winner banner only, no gold/white).
- The TV page does **not** hide during commercial breaks (§12.2) — people at the court should keep seeing the final score while the stream plays ads. (Flagged as open question Q2.)

### 12.2 Feature B — automatic commercial break after a match (+ manual button)

**Requested behavior:** 60 seconds after a match finishes → hide the score on stream → switch OBS away from the live scene to commercial videos → when the videos end, return to the live court scene **without** the score (the operator sets up the next teams meanwhile). Plus a button in the admin panel to run the same break manually at any moment, and the score must reappear for the next match.

**Architecture decision — OBS control comes back, but in the Node server this time (zero WPF changes).** The old C# `ObsWebSocketClient` was deleted with the replay feature; rather than resurrecting the C#→hub→OBS bridge, the Node server gets a small obs-websocket **v5 client** of its own:

- New `Scoreboard\src\obsclient.js` (~150 lines, no npm deps): uses Node's **built-in global `WebSocket`** (stable since Node 22; the machine runs v24 — bump `package.json` `engines` to `>=22`) + `crypto` for the v5 SHA-256 challenge auth. Needs only 4 requests: `GetVersion` (test), `SetCurrentProgramScene`, `GetMediaInputStatus`, and optionally `TriggerMediaInputAction` (restart). Auto-reconnect with backoff; every failure is reported as a status string, never a crash.
- The server is the right home because it already knows the match state (it owns the finish transition and the timers) and already handles non-scoring hub commands (the old `replay` relay slot).

**"Hide the score" = the overlay hides itself** (no OBS scene-item calls, no source names to configure): a new persisted display flag `state.display.scoreVisible` (default `true`). When `false`, `overlay.js` applies the existing `.hidden` fade-out class. On stream this is indistinguishable from disabling the browser source, and it survives OBS restarts. The referee page and admin previews keep showing the score regardless (only the broadcast overlay obeys the flag).

**Score reappearance rule:** `scoreVisible` flips back to `true` automatically in the reducer on `startMatch` or on the first `point` — i.e. exactly when the next match actually begins — plus a manual **"Show / hide score"** toggle button in the admin card for full control.

**OBS settings — stored server-side, never broadcast** (the referee's phone must not receive the OBS password): new file `obs-settings.json` saved next to the state file (`%AppData%\FipGoldBucharest\`), managed via `GET/POST /api/obs-settings` (used only by the admin page):

```jsonc
{
  "enabled": true,              // master switch for the automatic break
  "url": "ws://127.0.0.1:4455", // obs-websocket v5
  "password": "",
  "liveScene": "LIVE",
  "commercialsScene": "COMMERCIALS",
  "mediaSource": "Commercials", // the media/VLC source inside that scene
  "autoDelaySeconds": 60,       // finish → break countdown
  "maxBreakSeconds": 300        // safety cap if media status never reports "ended"
}
```

**Break orchestration (in `server.js`):**
1. *Auto trigger:* on every state change, watch for `status` becoming `'finished'` → start a countdown of `autoDelaySeconds`. Broadcast the countdown so the admin card shows "Commercials in 42s" with a **Cancel** button. If the status leaves `'finished'` before it fires (undo, `removeLastSet`, reset), the countdown cancels itself.
2. *Manual trigger:* new hub/REST commands (handled like `undo` — server-level, not reducer commands): `{type:'playCommercials'}` (run now), `{type:'cancelCommercials'}` (cancel countdown or abort a running break by switching straight back to the live scene).
3. *The break routine:*
   a. Apply `setDisplay {scoreVisible:false}` through the normal reducer (history + broadcast + persist for free); wait ~1s for the overlay fade.
   b. `SetCurrentProgramScene(commercialsScene)`.
   c. Poll `GetMediaInputStatus(mediaSource)` every 500ms until it reports ended/stopped/error — with a 3s opening grace period and the `maxBreakSeconds` hard cap (same battle-tested pattern as the old replay `WaitForMediaEndAsync`).
   d. `SetCurrentProgramScene(liveScene)`. `scoreVisible` stays `false` until the next match starts (or the manual toggle).
4. *Status for the UI:* the `{type:'state'}` broadcast gains a **transient sibling field** (not persisted, not part of `state`): `obs: { connected, breakPhase: 'idle'|'countdown'|'running', countdownEndsAt }` — the admin card renders its status dot and countdown from this.
5. *Degradation:* if OBS is unreachable, the routine still hides the score, reports `error` in the status, does **not** switch scenes, and never blocks scoring.

**Admin panel — new card "Commercial break"** (below "Court TV display"):
- Status row: OBS connection dot + break phase / countdown, **Test connection** button.
- Buttons: **▶ Play commercials now**, **Cancel**, **Show / hide score** toggle.
- Settings form: the `obs-settings.json` fields above (password as `<input type="password">`), Save via `POST /api/obs-settings`.

**Engine changes** (`scoring.js`): `display.scoreVisible: true` default; `point` and `startMatch` set it `true`. That is all — `playCommercials`/`cancelCommercials` are server-level, not reducer commands.

**Required OBS setup (user, documented in README):**
- Tools → WebSocket Server Settings → enable, note port + password.
- A scene named `COMMERCIALS` containing one **Media Source** named `Commercials`, pointing at the single merged commercials mp4 (confirmed, §12.3 item 1), with **"Restart playback when source becomes active"** ticked.
- The existing `LIVE` scene stays as-is.

### 12.3 Open questions to confirm before implementing

1. **Commercials source type — CONFIRMED (user, 2026-09-02)**: the user will merge the clips into **one single mp4**, played by a standard OBS **Media Source** named `Commercials`. No VLC dependency.
2. **Court TV during the break — CONFIRMED (user, 2026-09-02)**: `/tv` keeps showing the final score; only the stream (OBS program) switches to the commercials. `scoreVisible` therefore affects the `/overlay` page only.
3. **Auto-break default — CONFIRMED (user, 2026-09-02)**: enabled by default, with the visible countdown and a Cancel button in the admin card.
4. **Auto-break delay — CONFIRMED (user, 2026-09-02)**: must be **configurable** in the admin "Commercial break" card (`autoDelaySeconds`, shipped default 60s).
5. Scene names: keep `LIVE` (already exists from the replay era) and create `COMMERCIALS`, or different names? (Both are configurable in the new card.)

### 12.4 Implementation order

1. `/tv` page + `/api/info` + "Court TV display" admin card *(independent, no risk)*.
2. `scoring.js`: `scoreVisible` flag + auto-show on `point`/`startMatch`; `overlay.js` honors it; admin Show/hide toggle. Engine tests for the transitions.
3. `src/obsclient.js` + `obs-settings.json` persistence + `GET/POST /api/obs-settings` + Test connection.
4. Break orchestration in `server.js` (finish-watcher countdown, `playCommercials`/`cancelCommercials`, media polling, transient `obs` status in broadcasts).
5. Admin "Commercial break" card (status, countdown, buttons, settings form).
6. README: OBS setup section (websocket, COMMERCIALS scene, media source checklist).

### 12.5b Phase 2b additions (2026-09-02, implemented the same day)

User-requested follow-ups after live OBS testing:

- **Broadcast controls on the Home tab**: `/mobile` gains an operator-only **"Broadcast" card** — OBS status badge, 👥 Show/hide players, Show/hide score, ▶ Commercials, Cancel, and the live countdown/error line. It appears only when the page is opened with `?operator=1`, which is how the WPF Home tab now embeds it (`MainWindow.xaml.cs`); the referee's plain `/mobile` URL never shows it. The admin "Commercial break" card keeps the same buttons (plus its own 👥 Show players).
- **Players intro overlay**: new `/intro` page (`intro.html/.css/.js`) — a **transparent second OBS Browser Source** (1920×1080, above the camera in the LIVE scene) showing the tournament header (`display.title` falling back to "FIP GOLD BUCHAREST 2026", plus `display.subtitle`, e.g. "Qualifications") and the four players of the selected match with big flags, matching the user's reference mock. Toggled via a new persisted `display.introVisible` flag (plain `setDisplay`), with a fade; auto-hidden by `startMatch` and by the first `point`. Its URL has a Copy/Open row in the admin "OBS overlay URL" card.
- **Point label rename**: the sudden-death point label is **"SP"** (star point) instead of "GP" — changed at the source in `pointLabel` (see Confirmed decisions item 4).
- **Score-only undo/redo** (user request 2026-09-03): only scoring commands (`point`, `adjust*`, `saveSet`, `removeLastSet`, serve commands, `startMatch`/`finishMatch`/`setStatus`/`resetMatch`) create history entries, and undo/redo restore only the score fields (`server.js` `SCORE_FIELDS`/`UNDOABLE`/`withScoreFrom`). Team selection, display toggles (score/players visibility, title) and the elimination registry are never undone; `resetAll` clears the history. Covered by `test/break.e2e.js`.
- **Design tweaks** (2026-09-03): the gold left accent bar was removed from the intro header and from the scorebug/TV title bars.
- **Admin tab + Control Center main page** (user request 2026-09-04): the setup cards (OBS overlay URL + intro URL, Court TV display, Internet access) moved from the Score settings page to a new WPF tab "⚙ Admin" embedding `/settings` (`settings.html/js`, reuses `admin.css`), which is deliberately absent from the public port (404). `/` (both ports; `/home` alias) now serves `home.html/css/js`: a menu page in the style of fipgoldbucharest.ro (Bebas Neue / Archivo / DM Sans from Google Fonts, court-navy hero, gold pills, paper background) with cards for Scorebug, Court TV, Referee, Score settings, Teams, Media; `?key=` on any public request (incl. `/`) sets the key cookie and `home.js` appends the key to the control links. Score settings page (`/admin`) now holds only Match, Overlay display and Reset. White FIP logo copied to `public/fip-logo.png`.
- **Hero tiles simplified** (user request 2026-09-04, after seeing the row wrap): tiles are now Official website · FIP event · YouTube Live; the date moved into the hero tag ("● FIP GOLD · BUCUREȘTI · 7–13 SEPT 2026") (Date, Location and Production tiles removed, the MATCH LIVE/STANDBY label with them — the score block already shows the state); "Official site" and "FIP event" were removed from the top menu on both pages (they live only as tiles). On phones the tiles simply stack in one column.
- **Official site link** (user request 2026-09-04): "Official site" is now the first menu entry (Home + Scorebug pages) and a gold first hero tile ("OFFICIAL WEBSITE / FIPGOLDBUCHAREST.RO ↗", `.fact-site`) ahead of the FIP tile; both open https://fipgoldbucharest.ro/ in a new tab; full-row on phones.
- **Mobile optimisation + cache busting** (user request 2026-09-04, phone screenshot): at ≤720px the top bar gets a ☰ button (`.menu-btn`, toggles `.top.open`, closes on outside tap; Home + Scorebug pages) that opens the menu as an opaque dropdown; the CTA shrinks (Scorebug page shows "Widget ↗"); the hero tiles become a 2-column grid where the FIP and YouTube tiles span the full row (and Production spans it when the YouTube tile is hidden, via `:has()`); smaller title/tag/score cells so player names fit; one-column cards; embed options in two columns. Root cause of the stale white FIP tile on the phone: Cloudflare caches .css/.js at the edge and rewrites Cache-Control to max-age=14400 (4 h) despite the origin's no-cache — fixed by `versionAssets()` in `serveFile`: every local .css/.js reference in served HTML gets `?v=<file mtime>`, so each deploy is a new URL for the CDN and the browsers (needs a score-server restart to take effect).
- **FIP event link** (user request 2026-09-04, latest): "FIP event" is the first menu entry on the Home and Scorebug pages and a court-blue first hero tile ("INTERNATIONAL PADEL FEDERATION / FIP EVENT ↗", `.fact-fip`) before Date / Location / Production; both open https://www.padelfip.com/events/fip-gold-bucharest/ in a new tab.
- **Score server card inside the Admin page** (user request 2026-09-04, latest): the native WPF strip under the Admin WebView is gone; `settings.html` ends with a "Score server" card (`#hostCard`, hidden unless `window.chrome.webview` exists, i.e. inside the app): status dot + text, Stop/Start, Port, Auto start, Minimize to tray, Open in browser, ⟳ reload, OBS overlay (LAN) and Referee (LAN) URLs with Copy. Bridge: the page posts `{type: ready | startStop | setPort | setAutoStart | setMinimizeToTray | openInBrowser | reload}` via `chrome.webview.postMessage`; `MainWindow.xaml.cs` (`AttachSettingsBridge` on the Settings view's `WebMessageReceived`, `OnSettingsWebMessage`, `PushHostState`) answers with `{type:'host', running, status, kind(ok|warn|danger), port, autoStart, minimizeToTray, overlayUrl, mobileUrl}` — pushed on `ready`, after every setting change and from `SetScoreboardStatus` (so the 10 s health check keeps it fresh). Settings persist in `settings.json` as before (`ScoreboardPort` applies on next start). Because the page is served by the score server, the Admin tab's placeholder keeps a native row (status dot, Port box, "Start server") for when the server is stopped / failed / crashed. Removed native controls: `ChkMinimizeToTray`, `ChkScoreboardAutoStart`, `TxtOverlayUrl`, `TxtMobileUrl` and their Copy handlers.
- **Home rename, YouTube Live link, Admin tab consolidation** (user request 2026-09-04, late): the main page is now called **Home** (title, nav links; `/` and `/home` unchanged). New server setting `youtubeUrl` (`obs-settings.json`, `POST /api/obs-settings`, normalized by `sanitizeLink`: trimmed, `https://` added, only http(s) kept) edited in a "YouTube live stream" card on the Admin page; it travels in `obsStatusPayload().youtubeUrl` so the Home and Scorebug pages (both connect through `client.js`) show/hide a "▶ YouTube Live" menu entry (new tab) live, without reload. In the WPF shell the Home tab lost its top bar (status / referee URL / Copy / Minimize to tray) and the Score settings tab lost the Score server card; both were merged into one **Score server** card at the bottom of the Admin tab (status "Running on :port", Start/Stop, Port, Auto start, Minimize to tray, Open in browser, ⟳, OBS overlay URL + Referee remote URL with Copy). The duplicate Home-tab controls (`DotScoreboardHome`, `TxtScoreboardStatusHome`, `TxtMobileUrlHome`, `BtnCopyMobileUrlHome_Click`) were removed from `MainWindow.xaml(.cs)`. e2e: YouTube link saved/normalized, carried on the public ws, non-http(s) rejected. Follow-up (same day): the link also appears as a fourth red hero tile "WATCH ▶ YOUTUBE LIVE" (`#youtubeFact`, `.fact-yt`) next to Date / Location / Production, toggled together with the menu entry.
- **Scorebug page + main-page polish** (user requests 2026-09-04, evening): every main-page link opens in a new tab; the control cards/menu entries/CTA (`.needs-key`) stay hidden until a valid key is known — `home.js` verifies the `?key=`/cookie candidate against `GET /api/obs-settings` (200 only on LAN or with the key), forgets a stale cookie and shows an "Operator access ›" unlock field otherwise; the hero shows the live score (`#liveStatus` MATCH LIVE / MATCH OVER / STANDBY + a 4-row score block via `client.js`). The embed area first placed on the main page was moved, at the user's request, to a dedicated public **Scorebug page** `/scorebug` (`scorebug.html/js`, reuses `home.css`): scaled live preview of `/overlay?pos=top-left`, direct link + Copy link, and the `<iframe>` snippet builder (position, scale, width, height, Copy HTML) built from `location.origin`, so through the tunnel it reads `https://scorebug.fipgoldbucharest.com/overlay?pos=top-left`. The main page's Scorebug menu entry and card now open `/scorebug`; `PUBLIC_PAGES`/`PUBLIC_ASSET` include it; e2e checks the public port serves it.
- **Admin + Teams over the tunnel** (user request 2026-09-04, later): the same key (UI label now "Access key", URL parameter still `?key=`) also unlocks `/admin` and `/teams` on the public port. Keyed paths (`KEYED_PATHS` = the three pages + `/api/command`, `/api/teams`, `/api/info`, `/api/obs-settings`) are delegated to the main handler (`handleMainRequest`, extracted from the main `http.createServer`); a page opened with `?key=` sets a 30-day `key` cookie so the page's own fetches and WebSocket pass; `hasRefereeKey(url, req)` accepts query or cookie. `/media` (+ `/api/commercials`) is keyed as well so the whole app can be operated remotely; the public state message now carries the `obs` status (needed by the Media page, not sensitive). Admin card lists Admin/Teams/Media links too.
- **Referee page over the tunnel** (user request 2026-09-04): new server-side settings `publicHostname` and `refereeKey` (in `obs-settings.json`, editable in the admin "Internet access (tunnel)" card, which also builds the three public URLs). On the public port, `/mobile` and `POST /api/command` require `?key=<refereeKey>` (else 403), `/mobile.css|js` are served freely, and a WebSocket opened as `/ws?key=…` is marked as a referee socket whose commands are applied (`refereeSockets` WeakSet in `server.js`); `client.js` forwards the key from the page URL to the socket and the REST fallback. `/tv` was already public. Covered by `test/break.e2e.js`.
- **Auto-elimination + maximized window** (user request 2026-09-04): when a match reaches `finished` the server marks the losing side's `teamId` inactive via `setTeamActive` (`eliminateLoser` in `onStatusMaybeChanged`); if the result is reverted (status back to `live` via undo / undo set) that same team is reinstated, while a reset for the next match keeps the elimination. The WPF window starts `Maximized` (and restores maximized from the tray). Covered by `test/break.e2e.js`.
- **Overlay default position = top-left** (user request 2026-09-04): `overlay.css` anchors the scorebug at `left:40px; top:40px`; `overlay.js` treats a missing `?pos=` as `top-left` (and now applies `?scale=` even without `?pos=`, with the transform origin following the corner); the admin "OBS overlay URL" picker lists Top left first. `/tv` ignores position/scale.
- **Public read-only port** (FIP requirement, 2026-09-04): `server.js` opens a second listener (`PUBLIC_PORT`, default `PORT + 1` = 8081, `0` disables) serving only `/`, `/overlay`, `/tv`, `/intro`, their css/js, `client.js`, `countries.js`, `scoring.js`, `/flags/*.svg`, `GET /api/state`, and a broadcast-only `/ws` (`publicHub`, incoming messages dropped; state pushed without the `obs` status). Everything else → 404, non-GET → 405. This is the port to expose through a fixed-hostname HTTPS tunnel (Cloudflare Tunnel / Tailscale Funnel — README). `/api/info` reports `publicPort`; the admin "OBS overlay URL" card explains it. Covered by `test/break.e2e.js`.
- **Media tab** (user request 2026-09-03): new WPF tab "🎬 Media" in third position embedding `/media` (`media.html/js/css`). The Broadcast card moved there from the Home tab (the mobile page is referee-only again; the `?operator=1` mode was removed). Six spot buttons (`obsSettings.commercials`, defaults `Commercials\01_FIP_INTRO.mp4` … `06_MONDO.mov`, editable via `obs-settings.json` / `POST /api/obs-settings`, listed by `GET /api/commercials`) send `{type:'playCommercial', id}`: the server swaps the OBS media source's `local_file` to the spot (`GetInputSettings`/`SetInputSettings`), runs the normal break routine, then restores the merged break video. The status payload gains `currentCommercial`/`lastCommercial` (last played stays gold, playing pulses green). Score rule (refined 2026-09-04): after a *single spot* the score is always shown again (spots are played during the game); after Play-all / the automatic break it is restored only when it interrupted a live match with the score on, and stays hidden after a finished match. **Playlist breaks** (user request 2026-09-03): `obsSettings.breakMode` = `'playlist'` (default — "Play commercials" and the automatic break load all configured spots into the media source one after another, `TriggerMediaInputAction RESTART` between files, status payload carries `playlist`/`playlistIndex`/`playlistTotal`) or `'file'` (play the media source's own merged file); selectable under "Break content". **2026-09-04:** the whole Commercial break settings card (auto-break toggle, delay, break content, OBS URL/password, scenes, media source, max length, Save/Test) moved from the admin page to the bottom of the Media tab; its duplicate buttons (Play/Cancel/Hide score/Show players) were dropped since the Media tab already has them. Before every break the server also applies the equivalent of OBS "Fit to screen" to the media source (`GetVideoSettings` + `SetSceneItemTransform` with scale-to-inner-bounds = canvas), because spots of different resolutions otherwise inherit the previous file's scale and look cropped. Covered by `test/break.e2e.js`.
- Verified: 88/88 engine tests (introVisible transitions added), live browser checks of `/intro` (matches the mock, incl. the real M-Q-23 vs M-MD-27 pairing), the operator card's toggles, and that plain `/mobile` ships the card hidden.

### 12.5 Testing checklist (phase 2)

- [ ] `/tv` fills a 1920×1080 browser fully, black background, readable from distance; live updates < 1s; finished view collapses like the overlay; usable on a phone/tablet too.
- [ ] "Court TV display" URL uses the LAN IP (not 127.0.0.1) and opens from another device.
- [ ] Finish a match → admin shows the countdown → at 0 the overlay fades out, OBS switches to COMMERCIALS, the video plays, OBS returns to LIVE, the score stays hidden.
- [ ] Pick the next teams, press Start (or score the first point) → the scorebug fades back in.
- [ ] "Play commercials now" works mid-match; "Cancel" aborts both the countdown and a running break (returns to LIVE).
- [ ] Undoing the final set during the countdown cancels the break.
- [ ] OBS closed/wrong password: scoring keeps working, admin shows the error status, no scene stuck.
- [ ] `scoreboard-state.json` round-trips `scoreVisible`; `obs-settings.json` never appears in any WS broadcast (check a `/ws` dump from the referee phone).
