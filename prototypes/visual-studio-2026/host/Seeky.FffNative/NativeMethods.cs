using System.Runtime.InteropServices;

namespace Seeky.FffNative;

internal static partial class NativeMethods
{
    internal const string LibraryName = "fff_c";

    [LibraryImport(LibraryName, EntryPoint = "fff_create_instance2", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint CreateInstance(
        string basePath,
        string? frecencyDbPath,
        string? historyDbPath,
        [MarshalAs(UnmanagedType.I1)] bool useUnsafeNoLock,
        [MarshalAs(UnmanagedType.I1)] bool enableMmapCache,
        [MarshalAs(UnmanagedType.I1)] bool enableContentIndexing,
        [MarshalAs(UnmanagedType.I1)] bool watch,
        [MarshalAs(UnmanagedType.I1)] bool aiMode,
        string? logFilePath,
        string? logLevel,
        ulong cacheBudgetMaxFiles,
        ulong cacheBudgetMaxBytes,
        ulong cacheBudgetMaxFileSize);

    [LibraryImport(LibraryName, EntryPoint = "fff_destroy")]
    internal static partial void Destroy(nint handle);

    [LibraryImport(LibraryName, EntryPoint = "fff_wait_for_scan")]
    internal static partial nint WaitForScan(nint handle, ulong timeoutMs);

    [LibraryImport(LibraryName, EntryPoint = "fff_search", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint SearchFiles(
        nint handle,
        string query,
        string? currentFile,
        uint maxThreads,
        uint pageIndex,
        uint pageSize,
        int comboBoostMultiplier,
        uint minComboCount);

    [LibraryImport(LibraryName, EntryPoint = "fff_live_grep", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint LiveGrep(
        nint handle,
        string query,
        byte mode,
        ulong maxFileSize,
        uint maxMatchesPerFile,
        [MarshalAs(UnmanagedType.I1)] bool smartCase,
        uint fileOffset,
        uint pageLimit,
        ulong timeBudgetMs,
        uint beforeContext,
        uint afterContext,
        [MarshalAs(UnmanagedType.I1)] bool classifyDefinitions);

    [LibraryImport(LibraryName, EntryPoint = "fff_free_result")]
    internal static partial void FreeResult(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_free_search_result")]
    internal static partial void FreeSearchResult(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_free_grep_result")]
    internal static partial void FreeGrepResult(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_search_result_get_count")]
    internal static partial uint SearchResultGetCount(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_search_result_get_total_matched")]
    internal static partial uint SearchResultGetTotalMatched(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_search_result_get_total_files")]
    internal static partial uint SearchResultGetTotalFiles(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_search_result_get_item")]
    internal static partial nint SearchResultGetItem(nint result, uint index);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_count")]
    internal static partial uint GrepResultGetCount(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_total_matched")]
    internal static partial uint GrepResultGetTotalMatched(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_total_files_searched")]
    internal static partial uint GrepResultGetTotalFilesSearched(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_total_files")]
    internal static partial uint GrepResultGetTotalFiles(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_filtered_file_count")]
    internal static partial uint GrepResultGetFilteredFileCount(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_next_file_offset")]
    internal static partial uint GrepResultGetNextFileOffset(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_regex_fallback_error")]
    internal static partial nint GrepResultGetRegexFallbackError(nint result);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_result_get_match")]
    internal static partial nint GrepResultGetMatch(nint result, uint index);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_relative_path")]
    internal static partial nint FileItemGetRelativePath(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_file_name")]
    internal static partial nint FileItemGetFileName(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_git_status")]
    internal static partial nint FileItemGetGitStatus(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_size")]
    internal static partial ulong FileItemGetSize(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_modified")]
    internal static partial ulong FileItemGetModified(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_total_frecency_score")]
    internal static partial long FileItemGetTotalFrecencyScore(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_access_frecency_score")]
    internal static partial long FileItemGetAccessFrecencyScore(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_modification_frecency_score")]
    internal static partial long FileItemGetModificationFrecencyScore(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_file_item_get_is_binary")]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static partial bool FileItemGetIsBinary(nint item);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_relative_path")]
    internal static partial nint GrepMatchGetRelativePath(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_file_name")]
    internal static partial nint GrepMatchGetFileName(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_git_status")]
    internal static partial nint GrepMatchGetGitStatus(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_line_content")]
    internal static partial nint GrepMatchGetLineContent(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_line_number")]
    internal static partial ulong GrepMatchGetLineNumber(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_col")]
    internal static partial uint GrepMatchGetColumn(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_byte_offset")]
    internal static partial ulong GrepMatchGetByteOffset(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_size")]
    internal static partial ulong GrepMatchGetSize(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_modified")]
    internal static partial ulong GrepMatchGetModified(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_total_frecency_score")]
    internal static partial long GrepMatchGetTotalFrecencyScore(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_access_frecency_score")]
    internal static partial long GrepMatchGetAccessFrecencyScore(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_modification_frecency_score")]
    internal static partial long GrepMatchGetModificationFrecencyScore(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_is_definition")]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static partial bool GrepMatchGetIsDefinition(nint match);

    [LibraryImport(LibraryName, EntryPoint = "fff_grep_match_get_is_binary")]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static partial bool GrepMatchGetIsBinary(nint match);
}
