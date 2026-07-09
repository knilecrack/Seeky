using System.Runtime.InteropServices;

namespace Seeky.FffNative;

public sealed class FffSession : IDisposable
{
    private nint _handle;

    private FffSession(nint handle)
    {
        _handle = handle;
    }

    public static FffSession Create(FffCreateOptions options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(options.BasePath);
        FffNativeLibrary.EnsureResolverRegistered();

        var result = ConsumeResult(NativeMethods.CreateInstance(
            options.BasePath,
            options.FrecencyDbPath,
            options.HistoryDbPath,
            useUnsafeNoLock: false,
            options.EnableMmapCache,
            options.EnableContentIndexing,
            options.Watch,
            options.AiMode,
            options.LogFilePath,
            options.LogLevel,
            options.CacheBudgetMaxFiles,
            options.CacheBudgetMaxBytes,
            options.CacheBudgetMaxFileSize));

        if (!result.Success)
        {
            throw new FffNativeException(result.ErrorMessage ?? "fff_create_instance2 failed.");
        }

        if (result.Handle == nint.Zero)
        {
            throw new FffNativeException("fff_create_instance2 returned a null instance handle.");
        }

        return new FffSession(result.Handle);
    }

    public bool WaitForScan(TimeSpan timeout)
    {
        EnsureNotDisposed();

        var result = ConsumeResult(NativeMethods.WaitForScan(_handle, ToTimeoutMilliseconds(timeout)));
        if (!result.Success)
        {
            throw new FffNativeException(result.ErrorMessage ?? "fff_wait_for_scan failed.");
        }

        return result.IntValue != 0;
    }

    public FffFileSearchResult SearchFiles(string query, FffFileSearchOptions? options = null)
    {
        EnsureNotDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(query);

        options ??= new FffFileSearchOptions();

        var result = ConsumeResult(NativeMethods.SearchFiles(
            _handle,
            query,
            options.CurrentFile,
            options.MaxThreads,
            options.PageIndex,
            options.PageSize,
            options.ComboBoostMultiplier,
            options.MinComboCount));

        if (!result.Success)
        {
            throw new FffNativeException(result.ErrorMessage ?? "fff_search failed.");
        }

        if (result.Handle == nint.Zero)
        {
            return new FffFileSearchResult(Array.Empty<FffFileItem>(), 0, 0);
        }

        try
        {
            var count = NativeMethods.SearchResultGetCount(result.Handle);
            var items = new List<FffFileItem>((int)count);

            for (uint i = 0; i < count; i++)
            {
                var item = NativeMethods.SearchResultGetItem(result.Handle, i);
                if (item == nint.Zero)
                {
                    continue;
                }

                items.Add(new FffFileItem(
                    ReadString(NativeMethods.FileItemGetRelativePath(item)),
                    ReadString(NativeMethods.FileItemGetFileName(item)),
                    ReadNullableString(NativeMethods.FileItemGetGitStatus(item)),
                    NativeMethods.FileItemGetSize(item),
                    NativeMethods.FileItemGetModified(item),
                    NativeMethods.FileItemGetTotalFrecencyScore(item),
                    NativeMethods.FileItemGetAccessFrecencyScore(item),
                    NativeMethods.FileItemGetModificationFrecencyScore(item),
                    NativeMethods.FileItemGetIsBinary(item)));
            }

            return new FffFileSearchResult(
                items,
                NativeMethods.SearchResultGetTotalMatched(result.Handle),
                NativeMethods.SearchResultGetTotalFiles(result.Handle));
        }
        finally
        {
            NativeMethods.FreeSearchResult(result.Handle);
        }
    }

    public FffGrepResult SearchGrep(string query, FffGrepOptions? options = null)
    {
        EnsureNotDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(query);

        options ??= new FffGrepOptions();

        var result = ConsumeResult(NativeMethods.LiveGrep(
            _handle,
            query,
            (byte)options.Mode,
            options.MaxFileSize,
            options.MaxMatchesPerFile,
            options.SmartCase,
            options.FileOffset,
            options.PageLimit,
            options.TimeBudgetMs,
            options.BeforeContext,
            options.AfterContext,
            options.ClassifyDefinitions));

        if (!result.Success)
        {
            throw new FffNativeException(result.ErrorMessage ?? "fff_live_grep failed.");
        }

        if (result.Handle == nint.Zero)
        {
            return new FffGrepResult(Array.Empty<FffGrepMatch>(), 0, 0, 0, 0, 0, null);
        }

        try
        {
            var count = NativeMethods.GrepResultGetCount(result.Handle);
            var matches = new List<FffGrepMatch>((int)count);

            for (uint i = 0; i < count; i++)
            {
                var match = NativeMethods.GrepResultGetMatch(result.Handle, i);
                if (match == nint.Zero)
                {
                    continue;
                }

                matches.Add(new FffGrepMatch(
                    ReadString(NativeMethods.GrepMatchGetRelativePath(match)),
                    ReadString(NativeMethods.GrepMatchGetFileName(match)),
                    ReadNullableString(NativeMethods.GrepMatchGetGitStatus(match)),
                    ReadString(NativeMethods.GrepMatchGetLineContent(match)),
                    NativeMethods.GrepMatchGetLineNumber(match),
                    NativeMethods.GrepMatchGetColumn(match),
                    NativeMethods.GrepMatchGetByteOffset(match),
                    NativeMethods.GrepMatchGetSize(match),
                    NativeMethods.GrepMatchGetModified(match),
                    NativeMethods.GrepMatchGetTotalFrecencyScore(match),
                    NativeMethods.GrepMatchGetAccessFrecencyScore(match),
                    NativeMethods.GrepMatchGetModificationFrecencyScore(match),
                    NativeMethods.GrepMatchGetIsDefinition(match),
                    NativeMethods.GrepMatchGetIsBinary(match)));
            }

            return new FffGrepResult(
                matches,
                NativeMethods.GrepResultGetTotalMatched(result.Handle),
                NativeMethods.GrepResultGetTotalFilesSearched(result.Handle),
                NativeMethods.GrepResultGetTotalFiles(result.Handle),
                NativeMethods.GrepResultGetFilteredFileCount(result.Handle),
                NativeMethods.GrepResultGetNextFileOffset(result.Handle),
                ReadNullableString(NativeMethods.GrepResultGetRegexFallbackError(result.Handle)));
        }
        finally
        {
            NativeMethods.FreeGrepResult(result.Handle);
        }
    }

    public void Dispose()
    {
        if (_handle == nint.Zero)
        {
            return;
        }

        NativeMethods.Destroy(_handle);
        _handle = nint.Zero;
        GC.SuppressFinalize(this);
    }

    ~FffSession()
    {
        Dispose();
    }

    private void EnsureNotDisposed()
    {
        ObjectDisposedException.ThrowIf(_handle == nint.Zero, this);
    }

    private static ulong ToTimeoutMilliseconds(TimeSpan timeout)
    {
        if (timeout < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "Timeout must not be negative.");
        }

        return checked((ulong)timeout.TotalMilliseconds);
    }

    private static NativeCallResult ConsumeResult(nint resultPointer)
    {
        if (resultPointer == nint.Zero)
        {
            throw new FffNativeException("fff-c returned a null result pointer.");
        }

        NativeFffResult nativeResult;
        try
        {
            nativeResult = Marshal.PtrToStructure<NativeFffResult>(resultPointer);
        }
        finally
        {
            NativeMethods.FreeResult(resultPointer);
        }

        return new NativeCallResult(
            nativeResult.Success,
            ReadNullableString(nativeResult.Error),
            nativeResult.Handle,
            nativeResult.IntValue);
    }

    private static string ReadString(nint pointer)
    {
        return Marshal.PtrToStringUTF8(pointer) ?? string.Empty;
    }

    private static string? ReadNullableString(nint pointer)
    {
        return pointer == nint.Zero ? null : Marshal.PtrToStringUTF8(pointer);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFffResult
    {
        [MarshalAs(UnmanagedType.I1)]
        public bool Success;

        public nint Error;
        public nint Handle;
        public long IntValue;
    }

    private sealed record NativeCallResult(
        bool Success,
        string? ErrorMessage,
        nint Handle,
        long IntValue);
}
