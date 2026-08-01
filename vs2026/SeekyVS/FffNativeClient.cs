// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Search backend over the native fff C FFI library (<c>Tools/fff_c.dll</c>) — replaces the
/// fff-mcp stdio sidecar. One fff instance per workspace; workspace changes go through
/// <c>fff_restart_index</c> instead of recreating the instance.
/// </summary>
/// <remarks>
/// Memory management (per crates/fff-c/include/fff.h): every call returns a heap
/// <c>FffResult*</c> envelope freed with <c>fff_free_result</c>; the envelope does NOT own its
/// <c>handle</c> payload — payloads are freed separately (<c>fff_free_search_result</c>,
/// <c>fff_free_grep_result</c>, <c>fff_free_scan_progress</c>, <c>fff_destroy</c>). We pull all
/// fields through the accessor functions (no struct marshaling except the tiny blittable
/// <c>FffCreateOptions</c>/<c>FffScanProgress</c>), so every pointer is either freed exactly once
/// here or owned by the native instance. All native calls are serialized through a single gate —
/// fff's thread-safety guarantees are undocumented, and searches are fast enough that contention
/// is theoretical.
/// </remarks>
internal sealed partial class FffNativeClient : IDisposable
{
    private const string LibraryName = "fff_c.dll";
    private const uint CreateOptionsVersion = 2; // FFF_CREATE_OPTIONS_VERSION
    private const int ScanWaitTimeoutMs = 30_000;

    private static bool resolverInstalled;

    private readonly object gate = new();
    private IntPtr handle;
    private string? workspaceDir;

    /// <summary>Grep sub-mode for <c>fff_live_grep</c> (0 = plain SIMD, 1 = regex, 2 = fuzzy).</summary>
    internal enum GrepMode : byte
    {
        Plain = 0,
        Regex = 1,
        Fuzzy = 2,
    }

    /// <summary>A fuzzy file-search result.</summary>
    internal readonly record struct FileItem(string Path, long FrecencyScore);

    /// <summary>A single grep match.</summary>
    internal readonly record struct GrepMatch(string Path, int Line, string Text, int Col);

    /// <summary>Grep results plus the regex-fallback notice, if any.</summary>
    internal sealed record GrepResult(IReadOnlyList<GrepMatch> Matches, string? RegexFallbackError);

    /// <summary>
    /// Ensures an fff instance exists for <paramref name="dir"/>: creates it on first use,
    /// restarts the index when the workspace changed, no-ops otherwise. Waits for the initial
    /// scan to finish and reports progress through <paramref name="reportStatus"/>.
    /// </summary>
    public Task StartAsync(string dir, Action<string>? reportStatus, CancellationToken cancellationToken)
    {
        return Task.Run(
            () =>
            {
                lock (this.gate)
                {
                    this.EnsureInstanceCore(dir, reportStatus);
                }
            },
            cancellationToken);
    }

    /// <summary>Fuzzy file search; returns workspace-relative paths with frecency scores.</summary>
    public Task<IReadOnlyList<FileItem>> FindFilesAsync(string query, int maxResults, CancellationToken cancellationToken)
    {
        return Task.Run<IReadOnlyList<FileItem>>(
            () =>
            {
                lock (this.gate)
                {
                    IntPtr result = Native.fff_search(this.handle, query, null, 0, 0, (uint)maxResults, 0, 0);
                    IntPtr payload = UnwrapResult(result, "search");
                    try
                    {
                        uint count = Native.fff_search_result_get_count(payload);
                        var items = new List<FileItem>((int)count);
                        for (uint i = 0; i < count; i++)
                        {
                            IntPtr item = Native.fff_search_result_get_item(payload, i);
                            if (item == IntPtr.Zero)
                            {
                                continue;
                            }

                            string? path = PtrToString(Native.fff_file_item_get_relative_path(item));
                            if (path is not null)
                            {
                                items.Add(new FileItem(path, Native.fff_file_item_get_total_frecency_score(item)));
                            }
                        }

                        return items;
                    }
                    finally
                    {
                        Native.fff_free_search_result(payload);
                    }
                }
            },
            cancellationToken);
    }

    /// <summary>Content search in the given mode; the query is passed raw (fff parses
    /// <c>*.cs pattern</c>-style constraints itself).</summary>
    public Task<GrepResult> GrepAsync(string query, GrepMode mode, int maxResults, CancellationToken cancellationToken)
    {
        return Task.Run(
            () =>
            {
                lock (this.gate)
                {
                    IntPtr result = Native.fff_live_grep(
                        this.handle,
                        query,
                        (byte)mode,
                        maxFileSize: 0,
                        maxMatchesPerFile: 0,
                        smartCase: true,
                        fileOffset: 0,
                        pageLimit: (uint)maxResults,
                        timeBudgetMs: 0,
                        beforeContext: 0,
                        afterContext: 0,
                        classifyDefinitions: false);
                    IntPtr payload = UnwrapResult(result, "live_grep");
                    try
                    {
                        string? fallbackError = PtrToString(Native.fff_grep_result_get_regex_fallback_error(payload));
                        if (fallbackError is not null)
                        {
                            SeekyLog.Info($"fff live_grep: regex fallback: {fallbackError}");
                        }

                        uint count = Native.fff_grep_result_get_count(payload);
                        var matches = new List<GrepMatch>((int)count);
                        for (uint i = 0; i < count; i++)
                        {
                            IntPtr match = Native.fff_grep_result_get_match(payload, i);
                            if (match == IntPtr.Zero)
                            {
                                continue;
                            }

                            string? path = PtrToString(Native.fff_grep_match_get_relative_path(match));
                            if (path is null)
                            {
                                continue;
                            }

                            matches.Add(new GrepMatch(
                                path,
                                checked((int)Native.fff_grep_match_get_line_number(match)),
                                PtrToString(Native.fff_grep_match_get_line_content(match)) ?? string.Empty,
                                (int)Native.fff_grep_match_get_col(match)));
                        }

                        return new GrepResult(matches, fallbackError);
                    }
                    finally
                    {
                        Native.fff_free_grep_result(payload);
                    }
                }
            },
            cancellationToken);
    }

    /// <summary>
    /// Records a picked result for frecency learning (<c>fff_track_query</c>). Best-effort:
    /// failures are logged, never thrown.
    /// </summary>
    public Task TrackQueryAsync(string query, string relativePath, CancellationToken cancellationToken)
    {
        return Task.Run(
            () =>
            {
                try
                {
                    lock (this.gate)
                    {
                        if (this.handle == IntPtr.Zero)
                        {
                            return;
                        }

                        IntPtr result = Native.fff_track_query(this.handle, query, relativePath);
                        _ = UnwrapResult(result, "track_query", out long ok);
                        SeekyLog.Info($"fff track_query('{query}', '{relativePath}'): {(ok == 1 ? "ok" : "failed")}");
                    }
                }
                catch (Exception ex)
                {
                    SeekyLog.Error("fff track_query failed", ex);
                }
            },
            cancellationToken);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        lock (this.gate)
        {
            if (this.handle != IntPtr.Zero)
            {
                SeekyLog.Info("fff: destroying instance");
                Native.fff_destroy(this.handle);
                this.handle = IntPtr.Zero;
                this.workspaceDir = null;
            }
        }
    }

    // ------------------------------------------------------------------ instance lifecycle

    private void EnsureInstanceCore(string dir, Action<string>? reportStatus)
    {
        EnsureResolver();

        if (this.handle != IntPtr.Zero && string.Equals(this.workspaceDir, dir, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (this.handle != IntPtr.Zero)
        {
            SeekyLog.Info($"fff: restarting index for '{dir}' (was '{this.workspaceDir}')");
            reportStatus?.Invoke("reindexing…");
            IntPtr restartResult = Native.fff_restart_index(this.handle, dir);
            UnwrapResult(restartResult, "restart_index");
            this.workspaceDir = dir;
        }
        else
        {
            string extensionDir = Path.GetDirectoryName(typeof(FffNativeClient).Assembly.Location)
                ?? AppContext.BaseDirectory;
            string stateDir = Path.Combine(dir, ".vs", "seeky");
            Directory.CreateDirectory(stateDir);

            IntPtr basePath = Marshal.StringToCoTaskMemUTF8(dir);
            IntPtr frecencyDb = Marshal.StringToCoTaskMemUTF8(Path.Combine(stateDir, "frecency.db"));
            IntPtr historyDb = Marshal.StringToCoTaskMemUTF8(Path.Combine(stateDir, "history.db"));
            IntPtr logFile = Marshal.StringToCoTaskMemUTF8(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SeekyVS", "fff.log"));
            IntPtr logLevel = Marshal.StringToCoTaskMemUTF8("info");
            try
            {
                var options = new FffCreateOptions
                {
                    Version = CreateOptionsVersion,
                    BasePath = basePath,
                    FrecencyDbPath = frecencyDb,
                    HistoryDbPath = historyDb,
                    EnableMmapCache = 0,
                    EnableContentIndexing = 1,
                    Watch = 1,
                    AiMode = 0,
                    LogFilePath = logFile,
                    LogLevel = logLevel,
                    CacheBudgetMaxFiles = 0,
                    CacheBudgetMaxBytes = 0,
                    CacheBudgetMaxFileSize = 0,
                    EnableFsRootScanning = 0,
                    EnableHomeDirScanning = 0,
                    FollowSymlinks = 0,
                };
                SeekyLog.Info($"fff: creating instance for '{dir}' (dll '{extensionDir}\\Tools\\fff_c.dll')");
                IntPtr result = Native.fff_create_instance_with(in options);
                this.handle = UnwrapResult(result, "create_instance_with");
                if (this.handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException("fff create_instance_with returned a null handle");
                }

                this.workspaceDir = dir;
                SeekyLog.Info("fff: instance created");
            }
            finally
            {
                Marshal.FreeCoTaskMem(basePath);
                Marshal.FreeCoTaskMem(frecencyDb);
                Marshal.FreeCoTaskMem(historyDb);
                Marshal.FreeCoTaskMem(logFile);
                Marshal.FreeCoTaskMem(logLevel);
            }
        }

        // Wait for the (re)scan, polling progress for the status line.
        var waitStart = Stopwatch.StartNew();
        while (true)
        {
            reportStatus?.Invoke($"indexing… {this.GetScannedFileCount()} files");
            IntPtr waitResult = Native.fff_wait_for_scan(this.handle, 500);
            _ = UnwrapResult(waitResult, "wait_for_scan", out long completed);
            if (completed == 1)
            {
                break;
            }

            if (waitStart.ElapsedMilliseconds > ScanWaitTimeoutMs)
            {
                SeekyLog.Info("fff: scan wait timed out; continuing with a partial index");
                break;
            }
        }

        reportStatus?.Invoke($"index ready — {this.GetScannedFileCount()} files");
        SeekyLog.Info($"fff: scan complete in {waitStart.ElapsedMilliseconds}ms ({this.GetScannedFileCount()} files)");
    }

    private ulong GetScannedFileCount()
    {
        IntPtr result = Native.fff_get_scan_progress(this.handle);
        IntPtr payload = UnwrapResult(result, "get_scan_progress");
        try
        {
            if (payload == IntPtr.Zero)
            {
                return 0;
            }

            FffScanProgress progress = Marshal.PtrToStructure<FffScanProgress>(payload);
            return progress.ScannedFilesCount;
        }
        finally
        {
            Native.fff_free_scan_progress(payload);
        }
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>
    /// Checks the FffResult envelope, frees it, and returns the payload handle. On failure,
    /// throws with the native error string (the envelope is still freed exactly once).
    /// </summary>
    private static IntPtr UnwrapResult(IntPtr result, string operation) =>
        UnwrapResult(result, operation, out _);

    private static IntPtr UnwrapResult(IntPtr result, string operation, out long intValue)
    {
        intValue = 0;
        if (result == IntPtr.Zero)
        {
            throw new InvalidOperationException($"fff {operation}: null FffResult");
        }

        try
        {
            if (!Native.fff_result_get_success(result))
            {
                string error = PtrToString(Native.fff_result_get_error(result)) ?? "unknown error";
                SeekyLog.Info($"fff {operation} failed: {error}");
                throw new InvalidOperationException($"fff {operation}: {error}");
            }

            intValue = Native.fff_result_get_int_value(result);
            return Native.fff_result_get_handle(result);
        }
        finally
        {
            Native.fff_free_result(result);
        }
    }

    private static string? PtrToString(IntPtr ptr) =>
        ptr == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(ptr);

    // The extension host doesn't probe our folder for native assets — same pattern as the
    // WebView2Loader resolver: resolve fff_c.dll relative to the extension assembly.
    private static void EnsureResolver()
    {
        if (resolverInstalled)
        {
            return;
        }

        resolverInstalled = true;
        string extensionDir = Path.GetDirectoryName(typeof(FffNativeClient).Assembly.Location)
            ?? AppContext.BaseDirectory;
        string libraryPath = Path.Combine(extensionDir, "Tools", LibraryName);
        SeekyLog.Info($"fff loader path: {libraryPath} (exists: {File.Exists(libraryPath)})");

        NativeLibrary.SetDllImportResolver(typeof(FffNativeClient).Assembly, (name, _, _) =>
        {
            if (string.Equals(name, LibraryName, StringComparison.OrdinalIgnoreCase)
                && File.Exists(libraryPath))
            {
                return NativeLibrary.Load(libraryPath);
            }

            return IntPtr.Zero; // default resolution for everything else (user32 etc.)
        });
    }

    // ------------------------------------------------------------------ native bindings
    // Bound against crates/fff-c/include/fff.h (cbindgen). All functions return a heap
    // FffResult* except the fff_free_*/fff_destroy/fff_*_get_* accessors.

    private static partial class Native
    {
        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_create_instance_with(in FffCreateOptions opts);

        [LibraryImport(LibraryName)]
        internal static partial void fff_destroy(IntPtr handle);

        [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
        internal static partial IntPtr fff_search(
            IntPtr handle, string query, string? currentFile,
            uint maxThreads, uint pageIndex, uint pageSize,
            int comboBoostMultiplier, uint minComboCount);

        [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
        internal static partial IntPtr fff_live_grep(
            IntPtr handle, string query, byte mode,
            ulong maxFileSize, uint maxMatchesPerFile,
            [MarshalAs(UnmanagedType.I1)] bool smartCase,
            uint fileOffset, uint pageLimit, ulong timeBudgetMs,
            uint beforeContext, uint afterContext,
            [MarshalAs(UnmanagedType.I1)] bool classifyDefinitions);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_get_scan_progress(IntPtr handle);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_wait_for_scan(IntPtr handle, ulong timeoutMs);

        [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
        internal static partial IntPtr fff_restart_index(IntPtr handle, string newPath);

        [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
        internal static partial IntPtr fff_track_query(IntPtr handle, string query, string filePath);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_result(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_search_result(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_grep_result(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_scan_progress(IntPtr result);

        [LibraryImport(LibraryName)]
        [return: MarshalAs(UnmanagedType.I1)]
        internal static partial bool fff_result_get_success(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_result_get_error(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_result_get_handle(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial long fff_result_get_int_value(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_search_result_get_item(IntPtr result, uint index);

        [LibraryImport(LibraryName)]
        internal static partial uint fff_search_result_get_count(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_file_item_get_relative_path(IntPtr item);

        [LibraryImport(LibraryName)]
        internal static partial long fff_file_item_get_total_frecency_score(IntPtr item);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_result_get_match(IntPtr result, uint index);

        [LibraryImport(LibraryName)]
        internal static partial uint fff_grep_result_get_count(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_result_get_regex_fallback_error(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_match_get_relative_path(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_match_get_line_content(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial ulong fff_grep_match_get_line_number(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial uint fff_grep_match_get_col(IntPtr match);
    }

    // Blittable mirror of FffCreateOptions (cbindgen, x64 layout; C99 bool = 1 byte → byte).
    [StructLayout(LayoutKind.Sequential)]
    private struct FffCreateOptions
    {
        internal uint Version;
        internal IntPtr BasePath;
        internal IntPtr FrecencyDbPath;
        internal IntPtr HistoryDbPath;
        internal byte EnableMmapCache;
        internal byte EnableContentIndexing;
        internal byte Watch;
        internal byte AiMode;
        internal IntPtr LogFilePath;
        internal IntPtr LogLevel;
        internal ulong CacheBudgetMaxFiles;
        internal ulong CacheBudgetMaxBytes;
        internal ulong CacheBudgetMaxFileSize;
        internal byte EnableFsRootScanning;
        internal byte EnableHomeDirScanning;
        internal byte FollowSymlinks;
    }

    // Blittable mirror of FffScanProgress (uint64 + 3 bools, C layout = 16 bytes).
    [StructLayout(LayoutKind.Sequential)]
    private struct FffScanProgress
    {
        internal ulong ScannedFilesCount;
        internal byte IsScanning;
        internal byte IsWatcherReady;
        internal byte IsWarmupComplete;
    }
}
