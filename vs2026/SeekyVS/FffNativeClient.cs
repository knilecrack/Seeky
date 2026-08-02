// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
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

    private readonly System.Threading.Lock gate = new();
    private IntPtr handle;
    private string? workspaceDir;
    private bool scanWaitCompleted;

    /// <summary>Grep sub-mode for <c>fff_live_grep</c> (0 = plain SIMD, 1 = regex, 2 = fuzzy).</summary>
    internal enum GrepMode : byte
    {
        Plain = 0,
        Regex = 1,
        Fuzzy = 2,
    }

    /// <summary>A fuzzy file-search result.</summary>
    internal readonly record struct FileItem(string Path, long FrecencyScore, string? GitStatus, bool IsBinary);

    /// <summary>A directory-search result (fff_search_directories).</summary>
    internal readonly record struct DirItem(string Path, string Name);

    /// <summary>
    /// A single grep match. <paramref name="Ranges"/> holds the highlight spans as
    /// (start, end) UTF-16 char indices into <paramref name="Text"/> (the native side reports
    /// them as byte offsets into the UTF-8 line; converted here). Empty when the backend
    /// provides no ranges.
    /// </summary>
    internal readonly record struct GrepMatch(
        string Path, int Line, string Text, int Col, (int Start, int End)[] Ranges,
        string? GitStatus, bool IsBinary, bool IsDefinition);

    /// <summary>Grep results plus the regex-fallback notice, if any.</summary>
    internal sealed record GrepResult(IReadOnlyList<GrepMatch> Matches, string? RegexFallbackError);

    /// <summary>
    /// Ensures an fff instance exists for <paramref name="dir"/>: creates it on first use,
    /// restarts the index when the workspace changed, no-ops otherwise. Waits for the initial
    /// scan to finish and reports progress through <paramref name="reportStatus"/>.
    /// </summary>
    public Task StartAsync(string dir, Action<string>? reportStatus, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dir);

        return Task.Run(
            () =>
            {
                lock (gate)
                {
                    EnsureInstanceCore(dir, reportStatus, cancellationToken);
                }
            },
            cancellationToken);
    }

    /// <summary>Fuzzy file search; returns workspace-relative paths with frecency scores.
    /// <paramref name="currentFile"/> deprioritizes the currently open file (fff current_file).</summary>
    public Task<IReadOnlyList<FileItem>> FindFilesAsync(string query, string? currentFile, int maxResults, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxResults);

        return Task.Run<IReadOnlyList<FileItem>>(
            () =>
            {
                lock (gate)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ThrowIfNotStartedCore();
                    return SearchFilesCore(query, currentFile, maxResults, useGlob: false);
                }
            },
            cancellationToken);
    }

    /// <summary>Fuzzy directory search (fff_search_directories); paths are workspace-relative.</summary>
    public Task<IReadOnlyList<DirItem>> FindDirectoriesAsync(string query, string? currentFile, int maxResults, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxResults);

        return Task.Run<IReadOnlyList<DirItem>>(
            () =>
            {
                lock (gate)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ThrowIfNotStartedCore();

                    IntPtr result = CallWithWatchdog("search_directories", () => Native.fff_search_directories(handle, query, currentFile, 0, 0, (uint)maxResults));
                    IntPtr payload = UnwrapResult(result, "search_directories");
                    try
                    {
                        // v0.10.1 has no fff_dir_search_result_get_count export (it exists only
                        // on main) — read the count from the result struct header instead.
                        FffDirSearchResultHeader header = Marshal.PtrToStructure<FffDirSearchResultHeader>(payload);
                        uint count = header.Count;
                        var items = new List<DirItem>((int)count);
                        for (uint i = 0; i < count; i++)
                        {
                            IntPtr item = Native.fff_dir_search_result_get_item(payload, i);
                            if (item == IntPtr.Zero)
                            {
                                continue;
                            }

                            // FffDirItem { char* relative_path; char* dir_name; i32 frecency } —
                            // the header exposes no accessors, so marshal the tiny struct.
                            FffDirItem native = Marshal.PtrToStructure<FffDirItem>(item);
                            string? path = PtrToString(native.RelativePath);
                            if (path is not null)
                            {
                                items.Add(new DirItem(path, PtrToString(native.DirName) ?? path));
                            }
                        }

                        return (IReadOnlyList<DirItem>)items;
                    }
                    finally
                    {
                        Native.fff_free_dir_search_result(payload);
                    }
                }
            },
            cancellationToken);
    }

    /// <summary>
    /// Recent queries from fff's history LMDB (fff_get_historical_query; 0 = most recent).
    /// History is populated by fff_track_query, i.e. queries that led to a picked result.
    /// </summary>
    public Task<IReadOnlyList<string>> GetHistoryAsync(int max, CancellationToken cancellationToken)
    {
        return Task.Run<IReadOnlyList<string>>(
            () =>
            {
                lock (gate)
                {
                    var queries = new List<string>();
                    if (handle == IntPtr.Zero)
                    {
                        return (IReadOnlyList<string>)queries;
                    }

                    for (ulong offset = 0; offset < (ulong)max; offset++)
                    {
                        IntPtr result = Native.fff_get_historical_query(handle, offset);
                        IntPtr payload = UnwrapResult(result, "get_historical_query");
                        if (payload == IntPtr.Zero)
                        {
                            break; // no more history
                        }

                        try
                        {
                            string? query = PtrToString(payload);
                            if (string.IsNullOrEmpty(query))
                            {
                                break;
                            }

                            queries.Add(query);
                        }
                        finally
                        {
                            Native.fff_free_string(payload);
                        }
                    }

                    return (IReadOnlyList<string>)queries;
                }
            },
            cancellationToken);
    }

    /// <summary>
    /// "Git Modified" mode: files with a non-empty git status. Runs the normal fuzzy search and
    /// filters client-side. An empty query means "all modified files, ranked by frecency" — if
    /// <c>fff_search</c> returns nothing for it, fall back to <c>fff_glob</c> with '*'
    /// (glob-only search ranked by frecency, per the header).
    /// </summary>
    public Task<IReadOnlyList<FileItem>> GitModifiedAsync(string query, int maxResults, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxResults);

        return Task.Run<IReadOnlyList<FileItem>>(
            () =>
            {
                lock (gate)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ThrowIfNotStartedCore();

                    List<FileItem> items = SearchFilesCore(query, null, maxResults, useGlob: false);
                    if (items.Count == 0 && query.Length == 0)
                    {
                        SeekyLog.Info("fff: empty-query search returned nothing; falling back to fff_glob '*'");
                        items = SearchFilesCore("*", null, maxResults, useGlob: true);
                    }

                    return (IReadOnlyList<FileItem>)items
                        .Where(f => !string.IsNullOrEmpty(f.GitStatus))
                        .Take(maxResults)
                        .ToList();
                }
            },
            cancellationToken);
    }

    /// <summary>Asks fff to refresh its git-status cache (best-effort; logs the update count).</summary>
    public Task RefreshGitStatusAsync(CancellationToken cancellationToken)
    {
        return Task.Run(
            () =>
            {
                try
                {
                    lock (gate)
                    {
                        if (handle == IntPtr.Zero)
                        {
                            return;
                        }

                        IntPtr result = Native.fff_refresh_git_status(handle);
                        _ = UnwrapResult(result, "refresh_git_status", out long updated);
                        SeekyLog.Info($"fff refresh_git_status: {updated} files updated");
                    }
                }
                catch (Exception ex)
                {
                    SeekyLog.Error("fff refresh_git_status failed", ex);
                }
            },
            cancellationToken);
    }

    private List<FileItem> SearchFilesCore(string query, string? currentFile, int maxResults, bool useGlob)
    {
        IntPtr result = useGlob
            ? CallWithWatchdog("glob", () => Native.fff_glob(handle, query, currentFile, 0, 0, (uint)maxResults))
            : CallWithWatchdog("search", () => Native.fff_search(handle, query, currentFile, 0, 0, (uint)maxResults, 0, 0));
        IntPtr payload = UnwrapResult(result, useGlob ? "glob" : "search");
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
                    items.Add(new FileItem(
                        path,
                        Native.fff_file_item_get_total_frecency_score(item),
                        PtrToString(Native.fff_file_item_get_git_status(item)),
                        Native.fff_file_item_get_is_binary(item)));
                }
            }

            return items;
        }
        finally
        {
            Native.fff_free_search_result(payload);
        }
    }

    /// <summary>Content search in the given mode; the query is passed raw (fff parses
    /// <c>*.cs pattern</c>-style constraints itself).</summary>
    public Task<GrepResult> GrepAsync(string query, GrepMode mode, int maxResults, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxResults);

        return Task.Run(
            () =>
            {
                lock (gate)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ThrowIfNotStartedCore();

                    IntPtr result = CallWithWatchdog("live_grep", () => Native.fff_live_grep(
                        handle,
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
                        classifyDefinitions: true));
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

                            string text = PtrToString(Native.fff_grep_match_get_line_content(match)) ?? string.Empty;
                            matches.Add(new GrepMatch(
                                path,
                                checked((int)Native.fff_grep_match_get_line_number(match)),
                                text,
                                (int)Native.fff_grep_match_get_col(match),
                                ReadMatchRanges(match, text),
                                PtrToString(Native.fff_grep_match_get_git_status(match)),
                                Native.fff_grep_match_get_is_binary(match),
                                Native.fff_grep_match_get_is_definition(match)));
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
    /// Wraps a native call with a hang detector: if the call is still running after 5s a
    /// WATCHDOG line is logged (a hung fff call otherwise looks identical to "no results").
    /// Slow-but-finished calls over 1s are logged too.
    /// </summary>
    private static IntPtr CallWithWatchdog(string name, Func<IntPtr> call)
    {
        using var hangTimer = new System.Threading.Timer(
            _ => SeekyLog.Info($"WATCHDOG: fff {name} still running after 5s (possible native hang)"),
            null,
            5000,
            Timeout.Infinite);
        var stopwatch = Stopwatch.StartNew();
        IntPtr result = call();
        if (stopwatch.ElapsedMilliseconds > 1000)
        {
            SeekyLog.Info($"fff {name} took {stopwatch.ElapsedMilliseconds}ms");
        }

        return result;
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
                    lock (gate)
                    {
                        if (handle == IntPtr.Zero)
                        {
                            return;
                        }

                        IntPtr result = Native.fff_track_query(handle, query, relativePath);
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
        lock (gate)
        {
            if (handle != IntPtr.Zero)
            {
                SeekyLog.Info("fff: destroying instance");
                Native.fff_destroy(handle);
                handle = IntPtr.Zero;
                workspaceDir = null;
                scanWaitCompleted = false;
            }
        }
    }

    // ------------------------------------------------------------------ instance lifecycle

    private void EnsureInstanceCore(
        string dir,
        Action<string>? reportStatus,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureResolver();

        bool sameWorkspace = handle != IntPtr.Zero
            && string.Equals(workspaceDir, dir, StringComparison.OrdinalIgnoreCase);
        if (sameWorkspace && scanWaitCompleted)
        {
            return;
        }

        if (handle != IntPtr.Zero && !sameWorkspace)
        {
            SeekyLog.Info($"fff: restarting index for '{dir}' (was '{workspaceDir}')");
            reportStatus?.Invoke("reindexing…");
            IntPtr restartResult = Native.fff_restart_index(handle, dir);
            UnwrapResult(restartResult, "restart_index");
            workspaceDir = dir;
            scanWaitCompleted = false;
        }
        else if (handle == IntPtr.Zero)
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
                handle = UnwrapResult(result, "create_instance_with");
                if (handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException("fff create_instance_with returned a null handle");
                }

                workspaceDir = dir;
                scanWaitCompleted = false;
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
            cancellationToken.ThrowIfCancellationRequested();
            reportStatus?.Invoke($"indexing… {GetScannedFileCount()} files");
            IntPtr waitResult = Native.fff_wait_for_scan(handle, 500);
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

        scanWaitCompleted = true;
        reportStatus?.Invoke($"index ready — {GetScannedFileCount()} files");
        SeekyLog.Info($"fff: scan complete in {waitStart.ElapsedMilliseconds}ms ({GetScannedFileCount()} files)");
    }

    private void ThrowIfNotStartedCore()
    {
        if (handle == IntPtr.Zero)
        {
            throw new InvalidOperationException("The fff search instance has not been started.");
        }
    }

    private ulong GetScannedFileCount()
    {
        IntPtr result = Native.fff_get_scan_progress(handle);
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

    /// <summary>
    /// Reads a grep match's highlight spans. Native <c>FffMatchRange</c> values are BYTE offsets
    /// into the UTF-8 line, but the page works in UTF-16 char indices: the line is re-encoded
    /// to UTF-8 and each byte offset is mapped by decoding the prefix
    /// (<c>Encoding.UTF8.GetCharCount</c>). Offsets are clamped defensively (including
    /// mid-multibyte cuts and swapped ends); degenerate spans are dropped. The returned ranges
    /// borrow from the parent <c>FffGrepResult</c> — call only while it is alive; there is no
    /// separate free for them.
    /// </summary>
    private static (int Start, int End)[] ReadMatchRanges(IntPtr match, string lineText)
    {
        uint count = Native.fff_grep_match_get_match_ranges_count(match);
        if (count == 0 || lineText.Length == 0)
        {
            return [];
        }

        byte[] utf8 = Encoding.UTF8.GetBytes(lineText);
        var ranges = new List<(int Start, int End)>((int)count);
        for (uint i = 0; i < count; i++)
        {
            IntPtr rangePtr = Native.fff_grep_match_get_match_range(match, i);
            if (rangePtr == IntPtr.Zero)
            {
                continue;
            }

            FffMatchRange range = Marshal.PtrToStructure<FffMatchRange>(rangePtr);
            int startByte = (int)Math.Min(range.Start, (uint)utf8.Length);
            int endByte = (int)Math.Min(range.End, (uint)utf8.Length);
            if (endByte < startByte)
            {
                (startByte, endByte) = (endByte, startByte);
            }

            int start = Encoding.UTF8.GetCharCount(utf8, 0, startByte);
            int end = Encoding.UTF8.GetCharCount(utf8, 0, endByte);
            if (end > start)
            {
                ranges.Add((start, end));
            }
        }

        return [.. ranges];
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
        internal static partial IntPtr fff_glob(
            IntPtr handle, string pattern, string? currentFile,
            uint maxThreads, uint pageIndex, uint pageSize);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_refresh_git_status(IntPtr handle);

        [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
        internal static partial IntPtr fff_search_directories(
            IntPtr handle, string query, string? currentFile,
            uint maxThreads, uint pageIndex, uint pageSize);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_dir_search_result_get_item(IntPtr result, uint index);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_dir_search_result(IntPtr result);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_get_historical_query(IntPtr handle, ulong offset);

        [LibraryImport(LibraryName)]
        internal static partial void fff_free_string(IntPtr s);

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
        internal static partial IntPtr fff_file_item_get_git_status(IntPtr item);

        [LibraryImport(LibraryName)]
        [return: MarshalAs(UnmanagedType.I1)]
        internal static partial bool fff_file_item_get_is_binary(IntPtr item);

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
        internal static partial IntPtr fff_grep_match_get_git_status(IntPtr match);

        [LibraryImport(LibraryName)]
        [return: MarshalAs(UnmanagedType.I1)]
        internal static partial bool fff_grep_match_get_is_binary(IntPtr match);

        [LibraryImport(LibraryName)]
        [return: MarshalAs(UnmanagedType.I1)]
        internal static partial bool fff_grep_match_get_is_definition(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_match_get_line_content(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial ulong fff_grep_match_get_line_number(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial uint fff_grep_match_get_col(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial uint fff_grep_match_get_match_ranges_count(IntPtr match);

        [LibraryImport(LibraryName)]
        internal static partial IntPtr fff_grep_match_get_match_range(IntPtr match, uint index);
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

    // Blittable mirror of FffMatchRange (two uint32s, byte offsets into the UTF-8 line).
    [StructLayout(LayoutKind.Sequential)]
    private struct FffMatchRange
    {
        internal uint Start;
        internal uint End;
    }

    // Blittable mirror of FffDirItem (two char* + i32; C layout with 4-byte tail padding).
    [StructLayout(LayoutKind.Sequential)]
    private struct FffDirItem
    {
        internal IntPtr RelativePath;
        internal IntPtr DirName;
        internal int MaxAccessFrecency;
    }

    // Blittable mirror of the FffDirSearchResult header — v0.10.1 exports no count accessor,
    // so the count is read from the struct (layout matches the tagged v0.10.1 fff.h).
    [StructLayout(LayoutKind.Sequential)]
    private struct FffDirSearchResultHeader
    {
        internal IntPtr Items;
        internal IntPtr Scores;
        internal uint Count;
        internal uint TotalMatched;
        internal uint TotalDirs;
    }
}
