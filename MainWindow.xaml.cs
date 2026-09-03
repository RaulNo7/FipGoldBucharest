using System.Diagnostics;
using System.IO;
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

        ChkMinimizeToTray.IsChecked = _settings.MinimizeToTray;
        TxtScoreboardPort.Text = _settings.ScoreboardPort.ToString();
        ChkScoreboardAutoStart.IsChecked = _settings.ScoreboardAutoStart;
        UpdateScoreboardUrls(_settings.ScoreboardPort);

        _loading = false;
    }

    private void SaveSettingsFromUi()
    {
        _settings.MinimizeToTray = ChkMinimizeToTray.IsChecked == true;

        if (int.TryParse(TxtScoreboardPort.Text.Trim(), out var sbPort) && sbPort is > 0 and < 65536)
            _settings.ScoreboardPort = sbPort;
        _settings.ScoreboardAutoStart = ChkScoreboardAutoStart.IsChecked == true;

        if (!_scoreboardStarted)
            UpdateScoreboardUrls(_settings.ScoreboardPort);
    }

    private void UpdateScoreboardUrls(int port)
    {
        var host = ScoreboardServerService.GetLanAddress() ?? "127.0.0.1";
        TxtOverlayUrl.Text = $"http://{host}:{port}/overlay";
        TxtMobileUrl.Text = $"http://{host}:{port}/mobile";
        TxtMobileUrlHome.Text = TxtMobileUrl.Text;
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
                HideScoreboardViews();
                BtnScoreboardStartStop.Content = "Start";
                return;
            }

            _scoreboardStarted = true;
            SetScoreboardStatus($"Running on :{_scoreboard.Port}", "AccentBrush");
            TxtOverlayUrl.Text = _scoreboard.LanOverlayUrl;
            TxtMobileUrl.Text = _scoreboard.MobileUrl;
            TxtMobileUrlHome.Text = _scoreboard.MobileUrl;
            BtnScoreboardStartStop.Content = "Stop";

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
        BtnScoreboardStartStop.Content = "Start";
        TxtScoreboardPlaceholder.Text = "Scoreboard server is not running.";
        TxtHomePlaceholder.Text = "Score server is not running. Start it from the Score settings tab.";
        TxtTeamsPlaceholder.Text = "Teams list loads when the score server is running.";
        TxtMediaPlaceholder.Text = "Media controls load when the score server is running.";
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

    private void BtnScoreboardReload_Click(object sender, RoutedEventArgs e)
    {
        if (_scoreboardStarted)
            ShowScoreboardViews();
    }

    private void BtnOpenAdminBrowser_Click(object sender, RoutedEventArgs e)
    {
        Process.Start(new ProcessStartInfo { FileName = _scoreboard.AdminUrl, UseShellExecute = true });
    }

    private void BtnCopyOverlayUrl_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(TxtOverlayUrl.Text);
        }
        catch
        {
            // Clipboard can be locked by another process; ignore.
        }
    }

    private void BtnCopyMobileUrl_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(TxtMobileUrl.Text);
        }
        catch
        {
            // Clipboard can be locked by another process; ignore.
        }
    }

    private void BtnCopyMobileUrlHome_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Windows.Clipboard.SetText(TxtMobileUrlHome.Text);
        }
        catch
        {
            // Clipboard can be locked by another process; ignore.
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
            BtnScoreboardStartStop.Content = "Start";
            TxtScoreboardPlaceholder.Text = _scoreboard.LastError ?? "Scoreboard server stopped unexpectedly.";
            TxtHomePlaceholder.Text = TxtScoreboardPlaceholder.Text;
            TxtTeamsPlaceholder.Text = TxtScoreboardPlaceholder.Text;
            TxtMediaPlaceholder.Text = TxtScoreboardPlaceholder.Text;
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
        DotScoreboardHome.Fill = brush;
        TxtScoreboardStatusHome.Text = text;
    }
}
