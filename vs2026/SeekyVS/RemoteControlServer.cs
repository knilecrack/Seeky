// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;

/// <summary>
/// Remote-control channel so an in-proc extension (NeoVS) can show the picker.
/// VisualStudio.Extensibility commands live in this out-of-proc host and never surface
/// in <c>DTE.Commands</c> (verified against a running instance), so in-proc code cannot
/// ExecuteCommand its way here — the pipe is the deterministic bridge.
///
/// Listens on <c>\\.\pipe\seekyvs-&lt;devenvPid&gt;</c>, where the pid is the devenv that
/// loaded the extension, found by walking the host's ancestors (the ServiceHub spawn
/// chain ends at devenv). One UTF-8 line per request over a long-lived connection:
/// <c>mode</c> or <c>mode|query</c>, split on the first '|' (a grep query may itself
/// contain '|'). Answered with <c>ok</c> or <c>err &lt;message&gt;</c>.
///
/// Registered as a singleton in <c>InitializeServices</c>; every command takes it as a
/// constructor dependency so it is created when the shell activates the commands at
/// startup — that is what starts the pipe.
/// </summary>
public sealed partial class RemoteControlServer : IDisposable
{
    private readonly VisualStudioExtensibility extensibility;
    private readonly CancellationTokenSource shutdown = new();
    private NamedPipeServerStream? pipe;

    public RemoteControlServer(VisualStudioExtensibility extensibility)
    {
        this.extensibility = extensibility;
        int ownerPid = FindOwnerDevenvPid();
        string pipeName = $"seekyvs-{ownerPid}";
        SeekyLog.Info($"Remote control: listening on \\\\.\\pipe\\{pipeName} (owner devenv pid {ownerPid})");
        _ = Task.Run(() => this.ServeAsync(pipeName, this.shutdown.Token));
    }

    public void Dispose()
    {
        this.shutdown.Cancel();
        try
        {
            // Unblocks a pending WaitForConnectionAsync with ObjectDisposedException.
            // Sync dispose from the container's teardown; DisposeAsync has nothing to
            // await here — the pipe is idle or already broken.
            this.pipe?.Dispose();
        }
        catch (Exception)
        {
        }

        this.shutdown.Dispose();
    }

    private async Task ServeAsync(string pipeName, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            this.pipe = new NamedPipeServerStream(
                pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            try
            {
                await this.pipe.WaitForConnectionAsync(cancellationToken);
                SeekyLog.Info("Remote control: client connected");
                using var reader = new StreamReader(this.pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
                using var writer = new StreamWriter(this.pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
                while (this.pipe.IsConnected && !cancellationToken.IsCancellationRequested)
                {
                    string? line = await reader.ReadLineAsync(cancellationToken);
                    if (line is null)
                    {
                        break; // client hung up
                    }

                    await this.DispatchAsync(line, writer);
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            catch (Exception ex)
            {
                SeekyLog.Error("Remote control connection failed", ex);
            }
            finally
            {
                await this.pipe.DisposeAsync();
                this.pipe = null;
            }
        }
    }

    private async Task DispatchAsync(string line, StreamWriter writer)
    {
        string mode = line;
        string? query = null;
        int separator = line.IndexOf('|');
        if (separator >= 0)
        {
            mode = line[..separator];
            query = line[(separator + 1)..];
            if (query.Length == 0)
            {
                query = null;
            }
        }

        SeekyLog.Info($"Remote control: show mode='{mode}' query='{query ?? "(none)"}'");
        try
        {
            // Null client context: there is no command behind a pipe request. Workspace
            // resolution skips its active-document fallback and uses the solution dir.
            await SeekyModalWindowManager.ShowAsync(this.extensibility, null, mode, query);
            await writer.WriteLineAsync("ok");
        }
        catch (Exception ex)
        {
            SeekyLog.Error($"Remote control dispatch failed ({line})", ex);
            await writer.WriteLineAsync("err " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ owner devenv

    /// <summary>
    /// The pid of the devenv this host belongs to: the extension host is spawned through
    /// the ServiceHub chain by exactly one devenv, so the first devenv ancestor is it.
    /// Foreground/first-devenv heuristics (the popup's owner-window logic) are the fallback
    /// when the walk cannot see a parent (already exited, access denied).
    /// </summary>
    private static int FindOwnerDevenvPid()
    {
        try
        {
            int pid = Environment.ProcessId;
            for (int depth = 0; depth < 8; depth++)
            {
                int parent = ParentProcessId(pid);
                if (parent <= 0)
                {
                    break;
                }

                if (IsDevenv(parent))
                {
                    return parent;
                }

                pid = parent;
            }
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Remote control: devenv ancestor walk failed", ex);
        }

        IntPtr foreground = Native.GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            _ = Native.GetWindowThreadProcessId(foreground, out uint foregroundPid);
            if (foregroundPid != 0 && IsDevenv((int)foregroundPid))
            {
                SeekyLog.Info($"Remote control: ancestor walk found no devenv; using foreground devenv pid {foregroundPid}");
                return (int)foregroundPid;
            }
        }

        foreach (Process candidate in Process.GetProcessesByName("devenv"))
        {
            using (candidate)
            {
                if (candidate.MainWindowHandle != IntPtr.Zero)
                {
                    SeekyLog.Info($"Remote control: ancestor walk found no devenv; using first windowed devenv pid {candidate.Id}");
                    return candidate.Id;
                }
            }
        }

        // A harmless wrong name (logged above in the ctor): no client ever connects.
        SeekyLog.Info("Remote control: no devenv found at all; pipe name uses own pid");
        return Environment.ProcessId;
    }

    private static bool IsDevenv(int pid)
    {
        try
        {
            using Process process = Process.GetProcessById(pid);
            return process.ProcessName.Equals("devenv", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static int ParentProcessId(int pid)
    {
        IntPtr handle = Native.OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero)
        {
            return -1;
        }

        try
        {
            var info = new ProcessBasicInformation();
            int status = Native.NtQueryInformationProcess(
                handle, 0, ref info, Marshal.SizeOf<ProcessBasicInformation>(), out _);
            return status == 0 ? (int)info.InheritedFromUniqueProcessId : -1;
        }
        finally
        {
            Native.CloseHandle(handle);
        }
    }

    private const int ProcessQueryLimitedInformation = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private static partial class Native
    {
        [LibraryImport("ntdll.dll")]
        internal static partial int NtQueryInformationProcess(
            IntPtr processHandle,
            int processInformationClass,
            ref ProcessBasicInformation processInformation,
            int processInformationLength,
            out int returnLength);

        [LibraryImport("kernel32.dll", SetLastError = true)]
        internal static partial IntPtr OpenProcess(
            int processAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static partial bool CloseHandle(IntPtr handle);

        [LibraryImport("user32.dll")]
        internal static partial IntPtr GetForegroundWindow();

        [LibraryImport("user32.dll")]
        internal static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    }
}
