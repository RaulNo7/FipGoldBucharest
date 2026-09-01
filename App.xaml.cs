using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;

namespace FipGoldBucharest;

public partial class App : System.Windows.Application
{
    private const string MutexName = @"Local\FipGoldBucharest_SingleInstance";
    private const string ShowEventName = @"Local\FipGoldBucharest_ShowSignal";

    private static Mutex? _instanceMutex;
    private EventWaitHandle? _showSignal;
    private RegisteredWaitHandle? _showSignalRegistration;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    protected override void OnStartup(StartupEventArgs e)
    {
        _instanceMutex = new Mutex(initiallyOwned: true, MutexName, out var isFirstInstance);

        if (!isFirstInstance)
        {
            // Another instance is already running: bring it up and quit.
            try
            {
                using var signal = EventWaitHandle.OpenExisting(ShowEventName);
                signal.Set();
            }
            catch
            {
                ActivateExistingWindow();
            }

            Shutdown();
            return;
        }

        // First instance: listen for "show yourself" signals from later launches
        // (covers the window being hidden in the system tray).
        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        _showSignalRegistration = ThreadPool.RegisterWaitForSingleObject(
            _showSignal,
            (_, _) => Current?.Dispatcher.BeginInvoke(() => (Current.MainWindow as MainWindow)?.ShowFromTray()),
            null,
            Timeout.Infinite,
            executeOnlyOnce: false);

        base.OnStartup(e);
    }

    private static void ActivateExistingWindow()
    {
        try
        {
            var current = Process.GetCurrentProcess();
            foreach (var process in Process.GetProcessesByName(current.ProcessName))
            {
                if (process.Id == current.Id)
                    continue;

                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(process.MainWindowHandle, 9); // SW_RESTORE
                    SetForegroundWindow(process.MainWindowHandle);
                }
            }
        }
        catch
        {
            // Best effort only.
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _showSignalRegistration?.Unregister(null);
        _showSignal?.Dispose();
        try { _instanceMutex?.ReleaseMutex(); } catch { }
        _instanceMutex?.Dispose();
        base.OnExit(e);
    }
}
