namespace FipGoldBucharest.Models;

public sealed class AppSettings
{
    public bool MinimizeToTray { get; set; } = true;
    public bool StartMinimized { get; set; } = false;
    public int ScoreboardPort { get; set; } = 8080;
    public bool ScoreboardAutoStart { get; set; } = true;
    public string ScoreboardNodePath { get; set; } = "";
}
