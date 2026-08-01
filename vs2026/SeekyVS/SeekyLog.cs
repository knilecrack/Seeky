// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.IO;

/// <summary>
/// Tiny thread-safe file logger for spike diagnostics. Appends timestamped lines to
/// <c>%LOCALAPPDATA%\SeekyVS\seekyvs.log</c>. Never throws — logging must never break the
/// extension whose failure we are trying to diagnose.
/// </summary>
internal static class SeekyLog
{
    private static readonly object Sync = new();

    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SeekyVS",
        "seekyvs.log");

    /// <summary>Logs an informational step.</summary>
    public static void Info(string message) => Write("INFO", message);

    /// <summary>Logs an exception with full stack trace.</summary>
    public static void Error(string message, Exception ex) => Write("ERROR", message + Environment.NewLine + ex);

    private static void Write(string level, string message)
    {
        try
        {
            lock (Sync)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                File.AppendAllText(
                    LogPath,
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{level}] [tid {Environment.CurrentManagedThreadId}] {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Never throw from the logger.
        }
    }
}
