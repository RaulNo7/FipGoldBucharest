using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using FipGoldBucharest.Models;
using FipGoldBucharest.Services;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace FipGoldBucharest;

public partial class MainWindow : Window
{
    private readonly AppSettings _settings;
    private bool _loading;
    private Forms.NotifyIcon? _trayIcon;
    private readonly System.Windows.Threading.DispatcherTimer _healthTimer = new() { Interval = TimeSpan.FromSeconds(10) };
    private readonly ScoreboardServerService _scoreboard = new();
    private bool _scoreboardStarted;
    private Task<CoreWebView2Environment>? _webViewEnvironmentTask;
    private bool _settingsBridgeAttached;
    private string _statusText = "Stopped";
    private string _statusKind = "warn"; // ok | warn | danger — mirrored by the Score server card on the Admin page

    public MainWindow()
    {
        InitializeComponent();

        _settings = SettingsService.Load();
        LoadSettingsToUi();

        Loaded += async (_, _) =>
        {
            InitializeTrayIcon();

            _healthTimer.Tick += async (_, _) => await CheckScoreboardHealthAsync();
            _healthTimer.Start();

            if (_settings.StartMinimized)
                HideToTray();

            if (_settings.ScoreboardAutoStart)
                await StartScoreboardAsync();
        };

        StateChanged += (_, _) =>
        {
            if (WindowState == WindowState.Minimized && _settings.MinimizeToTray)
                HideToTray();
        };

        Closing += (_, _) =>
        {
            _healthTimer.Stop();
            _trayIcon?.Dispose();
            SaveSettingsFromUi();
            SettingsService.Save(_settings);
            _scoreboard.Dispose();
        };
    }

    private void LoadSettingsToUi()
    {
        _loading = true;
        TxtScoreboardPort.Text = _settings.ScoreboardPort.ToString();
        _loading = false;
    }

    /// <summary>The port box in the Admin placeholder (the only native setting left; the rest lives on the Admin page).</summary>
    private void SaveSettingsFromUi()
    {
        if (int.TryParse(TxtScoreboardPort.Text.Trim(), out var sbPort) && sbPort is > 0 and < 65536)
            _settings.ScoreboardPort = sbPort;
    }

    private void Settings_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading || !IsLoaded)
            return;

        SaveSettingsFromUi();
        SettingsService.Save(_settings);
    }

    private void InitializeTrayIcon()
    {
        if (_trayIcon is not null)
            return;

        Drawing.Icon trayIconImage;
        try
        {
            trayIconImage = Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? Drawing.SystemIcons.Application;
        }
        catch
        {
            trayIconImage = Drawing.SystemIcons.Application;
        }

        _trayIcon = new Forms.NotifyIcon
        {
            Icon = trayIconImage,
            Text = "FIP Gold Bucharest 2026",
            Visible = true,
            ContextMenuStrip = new Forms.ContextMenuStrip()
        };

        _trayIcon.DoubleClick += (_, _) => ShowFromTray();

        _trayIcon.ContextMenuStrip.Items.Add("Show", null, (_, _) => ShowFromTray());
        _trayIcon.ContextMenuStrip.Items.Add("Exit", null, (_, _) =>
        {
            _settings.MinimizeToTray = false;
            Close();
        });
    }

    private void HideToTray()
    {
        Hide();
        if (_trayIcon is not null)
            _trayIcon.Visible = true;
    }

    public void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Maximized;
        Activate();
    }

    // -----------------------------------------------------------------------
    // Padel scoreboard integration
    // -----------------------------------------------------------------------

    private async void BtnScoreboardStartStop_Click(object sender, RoutedEventArgs e)
    {
        if (_scoreboardStarted)
            StopScoreboard();
        else
            await StartScoreboardAsync();
    }

    private async Task StartScoreboardAsync()
    {
        BtnScoreboardStartStop.IsEnabled = false;
        SetScoreboardStatus("Starting...", "WarningBrush");

        try
        {
            SaveSettingsFromUi();

            var ok = await _scoreboard.StartAsync(_settings.ScoreboardPort, _settings.ScoreboardNodePath);

            if (!ok)
            {
                _scoreboardStarted = false;
                SetScoreboardStatus("Failed", "DangerBrush");
                TxtScoreboardPlaceholder.Text = _scoreboard.LastError ?? "Scoreboard server could not start.";
                TxtHomePlaceholder.Text = TxtScoreboardPlaceholder.Text;
                TxtTeamsPlaceholder.Text = TxtScoreboardPlaceholder.Text;
                TxtMediaPlaceholder.Text = TxtScoreboardPlaceholder.Text;
                TxtSettingsPlaceholder.Text = TxtScoreboardPlaceholder.Text;
                HideScoreboardViews();
                return;
            }

            _scoreboardStarted = true;
            SetScoreboardStatus($"Running on :{_scoreboard.Port}", "AccentBrush");

            ShowScoreboardViews();
        }
        finally
        {
            BtnScoreboardStartStop.IsEnabled = true;
        }
    }

    private void StopScoreboard()
    {
        _scoreboard.Stop();
        _scoreboardStarted = false;
        SetScoreboardStatus("Stopped", "WarningBrush");
        TxtScoreboardPlaceholder.Text = "Scoreboard server is not running.";
        TxtHomePlaceholder.Text = "Score server is not running. Start it from the Admin tab.";
        TxtTeamsPlaceholder.Text = "Teams list loads when the score server is running.";
        TxtMediaPlaceholder.Text = "Media controls load when the score server is running.";
        TxtSettingsPlaceholder.Text = "Admin settings load when the score server is running.";
        HideScoreboardViews();
    }

    private void HideScoreboardViews()
    {
        ScoreboardWebView.Visibility = Visibility.Collapsed;
        ScoreboardPlaceholder.Visibility = Visibility.Visible;
        HomeWebView.Visibility = Visibility.Collapsed;
        HomePlaceholder.Visibility = Visibility.Visible;
        TeamsWebView.Visibility = Visibility.Collapsed;
        TeamsPlaceholder.Visibility = Visibility.Visible;
        MediaWebView.Visibility = Visibility.Collapsed;
        MediaPlaceholder.Visibility = Visibility.Visible;
        SettingsWebView.Visibility = Visibility.Collapsed;
        SettingsPlaceholder.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// Loads the embedded pages into the WebViews. Each view initializes
    /// independently: the WPF WebView2 cannot finish EnsureCoreWebView2Async
    /// until its control enters the visual tree, and the background-tab views
    /// would otherwise keep the visible Home view stuck on its placeholder.
    /// </summary>
    private void ShowScoreboardViews()
    {
        _ = InitWebViewAsync(HomeWebView, HomePlaceholder, TxtHomePlaceholder,
            $"http://127.0.0.1:{_scoreboard.Port}/mobile");
        _ = InitWebViewAsync(ScoreboardWebView, ScoreboardPlaceholder, TxtScoreboardPlaceholder,
            _scoreboard.AdminUrl);
        _ = InitWebViewAsync(MediaWebView, MediaPlaceholder, TxtMediaPlaceholder,
            $"http://127.0.0.1:{_scoreboard.Port}/media");
        _ = InitWebViewAsync(TeamsWebView, TeamsPlaceholder, TxtTeamsPlaceholder,
            _scoreboard.TeamsUrl);
        _ = InitWebViewAsync(SettingsWebView, SettingsPlaceholder, TxtSettingsPlaceholder,
            $"http://127.0.0.1:{_scoreboard.Port}/settings");
    }

    private Task<CoreWebView2Environment> GetWebViewEnvironmentAsync()
    {
        return _webViewEnvironmentTask ??= CoreWebView2Environment.CreateAsync(
            userDataFolder: Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "FipGoldBucharest",
                "WebView2"));
    }

    private async Task InitWebViewAsync(
        Microsoft.Web.WebView2.Wpf.WebView2 view,
        UIElement placeholder,
        System.Windows.Controls.TextBlock placeholderText,
        string url)
    {
        try
        {
            if (view.CoreWebView2 is null)
            {
                var environment = await GetWebViewEnvironmentAsync();
                await view.EnsureCoreWebView2Async(environment);
            }

            if (ReferenceEquals(view, SettingsWebView))
                AttachSettingsBridge();

            view.CoreWebView2!.Navigate(url);
            view.Visibility = Visibility.Visible;
            placeholder.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            // WebView2 runtime missing or failed — fall back to the browser.
            view.Visibility = Visibility.Collapsed;
            placeholder.Visibility = Visibility.Visible;
            placeholderText.Text =
                "Embedded view unavailable (" + ex.Message + ").\nUse \"Open in browser\" instead.";
        }
    }

    // -----------------------------------------------------------------------
    // Score server card on the Admin page (settings.html) <-> this window.
    // The page posts {type: ready|startStop|setPort|setAutoStart|setMinimizeToTray|openInBrowser|reload}
    // and receives {type:'host', running, status, kind, port, autoStart, minimizeToTray, overlayUrl, mobileUrl}.
    // -----------------------------------------------------------------------

    private void AttachSettingsBridge()
    {
        if (_settingsBridgeAttached || SettingsWebView.CoreWebView2 is null)
            return;
        _settingsBridgeAttached = true;
        SettingsWebView.CoreWebView2.WebMessageReceived += OnSettingsWebMessage;
    }

    private async void OnSettingsWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(e.WebMessageAsJson);
        }
        catch
        {
            return;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeProp))
                return;

            switch (typeProp.GetString())
            {
                case "ready":
                    PushHostState();
                    break;

                case "startStop":
                    if (_scoreboardStarted)
                        StopScoreboard();
                    else
                        await StartScoreboardAsync();
                    break;

                case "setPort":
                    if (root.TryGetProperty("port", out var portProp) && portProp.TryGetInt32(out var port) && port is > 0 and < 65536)
                    {
                        _settings.ScoreboardPort = port;
                        _loading = true;
                        TxtScoreboardPort.Text = port.ToString();
                        _loading = false;
                        SettingsService.Save(_settings);
                    }
                    PushHostState();
                    break;

                case "setAutoStart":
                    _settings.ScoreboardAutoStart = root.TryGetProperty("value", out var autoProp) && autoProp.ValueKind == JsonValueKind.True;
                    SettingsService.Save(_settings);
                    PushHostState();
                    break;

                case "setMinimizeToTray":
                    _settings.MinimizeToTray = root.TryGetProperty("value", out var trayProp) && trayProp.ValueKind == JsonValueKind.True;
                    SettingsService.Save(_settings);
                    PushHostState();
                    break;

                case "openInBrowser":
                    Process.Start(new ProcessStartInfo { FileName = _scoreboard.AdminUrl, UseShellExecute = true });
                    break;

                case "reload":
                    if (_scoreboardStarted)
                        ShowScoreboardViews();
                    break;
            }
        }
    }

    private void PushHostState()
    {
        if (SettingsWebView.CoreWebView2 is null)
            return;

        var host = ScoreboardServerService.GetLanAddress() ?? "127.0.0.1";
        var port = _scoreboardStarted ? _scoreboard.Port : _settings.ScoreboardPort;
        var json = JsonSerializer.Serialize(new
        {
            type = "host",
            running = _scoreboardStarted,
            status = _statusText,
            kind = _statusKind,
            port = _settings.ScoreboardPort,
            autoStart = _settings.ScoreboardAutoStart,
            minimizeToTray = _settings.MinimizeToTray,
            overlayUrl = $"http://{host}:{port}/overlay",
            mobileUrl = $"http://{host}:{port}/mobile",
        });

        try
        {
            SettingsWebView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch
        {
            // The view may be mid-navigation; the page asks again with "ready" when it loads.
        }
    }

    private async Task CheckScoreboardHealthAsync()
    {
        if (!_scoreboardStarted)
            return;

        var responding = await _scoreboard.IsServerRespondingAsync();

        if (responding)
        {
            SetScoreboardStatus($"Running on :{_scoreboard.Port}", "AccentBrush");
        }
        else if (!_scoreboard.IsProcessRunning)
        {
            _scoreboardStarted = false;
            SetScoreboardStatus("Crashed", "DangerBrush");
            TxtScoreboardPlaceholder.Text = _scoreboard.LastError ?? "Scoreboard server stopped unexpectedly.";
            TxtHomePlaceholder.Text = TxtScoreboardPlaceholder.Text;
            TxtTeamsPlaceholder.Text = TxtScoreboardPlaceholder.Text;
            TxtMediaPlaceholder.Text = TxtScoreboardPlaceholder.Text;
            TxtSettingsPlaceholder.Text = TxtScoreboardPlaceholder.Text;
            HideScoreboardViews();
        }
        else
        {
            SetScoreboardStatus("Not responding", "WarningBrush");
        }
    }

    private void SetScoreboardStatus(string text, string brushKey)
    {
        var brush = (System.Windows.Media.Brush)FindResource(brushKey);
        DotScoreboard.Fill = brush;
        TxtScoreboardStatus.Text = text;
        _statusText = text;
        _statusKind = brushKey switch { "AccentBrush" => "ok", "DangerBrush" => "danger", _ => "warn" };
        PushHostState();
    }
}
