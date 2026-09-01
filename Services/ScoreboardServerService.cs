using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace FipGoldBucharest.Services;

/// <summary>
/// Hosts the bundled Node.js padel scoreboard server (Scoreboard\server.js)
/// as a hidden child process and monitors its health over HTTP.
/// </summary>
public sealed class ScoreboardServerService : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    private Process? _process;
    private readonly object _lock = new();

    public int Port { get; private set; } = 8080;

    public string AdminUrl => $"http://127.0.0.1:{Port}/admin";
    public string OverlayUrl => $"http://127.0.0.1:{Port}/overlay";
    public string TeamsUrl => $"http://127.0.0.1:{Port}/teams";

    /// <summary>Best LAN host for URLs shared with other devices (falls back to 127.0.0.1).</summary>
    public string LanHost => GetLanAddress() ?? "127.0.0.1";
    public string LanOverlayUrl => $"http://{LanHost}:{Port}/overlay";
    public string MobileUrl => $"http://{LanHost}:{Port}/mobile";

    /// <summary>IPv4 address of the interface that routes to the local network.</summary>
    public static string? GetLanAddress()
    {
        try
        {
            // Connecting a UDP socket sends no packets but selects the outbound
            // interface, giving us the LAN address even with multiple adapters.
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect("8.8.8.8", 65530);
            return (socket.LocalEndPoint as IPEndPoint)?.Address.ToString();
        }
        catch
        {
            try
            {
                return Dns.GetHostAddresses(Dns.GetHostName())
                    .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a))
                    ?.ToString();
            }
            catch
            {
                return null;
            }
        }
    }

    /// <summary>True when the child process we started is alive.</summary>
    public bool IsProcessRunning
    {
        get
        {
            lock (_lock)
                return _process is { HasExited: false };
        }
    }

    public string? LastError { get; private set; }

    public static string ScoreboardDirectory =>
        Path.Combine(AppContext.BaseDirectory, "Scoreboard");

    private static string StateFilePath =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "FipGoldBucharest",
            "scoreboard-state.json");

    /// <summary>
    /// Finds a node.exe to run the scoreboard with. Order: explicit setting,
    /// portable runtime next to the app, then whatever "node" resolves to on PATH.
    /// </summary>
    public static string? FindNodeExe(string? configuredPath)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
            return configuredPath;

        var localBundle = Path.Combine(AppContext.BaseDirectory, ".node");
        if (Directory.Exists(localBundle))
        {
            var found = Directory.GetFiles(localBundle, "node.exe", SearchOption.AllDirectories).FirstOrDefault();
            if (found is not null)
                return found;
        }

        var pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
        foreach (var dir in pathDirs)
        {
            try
            {
                var candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate))
                    return candidate;
            }
            catch
            {
                // Malformed PATH entry — skip it.
            }
        }

        return null;
    }

    /// <summary>Checks whether a scoreboard server already answers on the port.</summary>
    public async Task<bool> IsServerRespondingAsync()
    {
        try
        {
            using var response = await Http.GetAsync($"http://127.0.0.1:{Port}/api/state");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Starts the scoreboard server. Returns true when the server answers on
    /// HTTP afterwards (also true if some other instance already serves the port).
    /// </summary>
    public async Task<bool> StartAsync(int port, string? nodeExePath)
    {
        Port = port;
        LastError = null;

        if (await IsServerRespondingAsync())
            return true; // already running (this app or an external one)

        var nodeExe = FindNodeExe(nodeExePath);
        if (nodeExe is null)
        {
            LastError = "Node.js not found. Install Node.js or set its path in settings.";
            return false;
        }

        var serverJs = Path.Combine(ScoreboardDirectory, "server.js");
        if (!File.Exists(serverJs))
        {
            LastError = $"Scoreboard files missing: {serverJs}";
            return false;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(StateFilePath)!);

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "server.js",
                WorkingDirectory = ScoreboardDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.EnvironmentVariables["PORT"] = Port.ToString();
            startInfo.EnvironmentVariables["STATE_FILE"] = StateFilePath;

            lock (_lock)
            {
                StopProcess();
                _process = Process.Start(startInfo);
            }

            if (_process is null)
            {
                LastError = "Could not start the Node.js process.";
                return false;
            }

            _process.OutputDataReceived += (_, _) => { };
            _process.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data))
                    LastError = e.Data;
            };
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            // Wait until the server answers (up to ~5 seconds).
            for (var i = 0; i < 20; i++)
            {
                if (_process.HasExited)
                {
                    LastError ??= $"Scoreboard server exited with code {_process.ExitCode}.";
                    return false;
                }

                if (await IsServerRespondingAsync())
                    return true;

                await Task.Delay(250);
            }

            LastError = "Scoreboard server did not respond in time.";
            return false;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            return false;
        }
    }

    public void Stop()
    {
        lock (_lock)
            StopProcess();
    }

    private void StopProcess()
    {
        if (_process is null)
            return;

        try
        {
            if (!_process.HasExited)
                _process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Process already gone.
        }

        _process.Dispose();
        _process = null;
    }

    public void Dispose() => Stop();
}
