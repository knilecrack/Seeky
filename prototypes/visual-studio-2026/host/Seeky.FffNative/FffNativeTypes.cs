namespace Seeky.FffNative;

public enum FffGrepMode : byte
{
    Plain = 0,
    Regex = 1,
    Fuzzy = 2,
}

public sealed record FffCreateOptions(
    string BasePath,
    string? FrecencyDbPath = null,
    string? HistoryDbPath = null,
    bool EnableMmapCache = false,
    bool EnableContentIndexing = false,
    bool Watch = false,
    bool AiMode = false,
    string? LogFilePath = null,
    string? LogLevel = null,
    ulong CacheBudgetMaxFiles = 0,
    ulong CacheBudgetMaxBytes = 0,
    ulong CacheBudgetMaxFileSize = 0);

public sealed record FffFileSearchOptions(
    string? CurrentFile = null,
    uint MaxThreads = 0,
    uint PageIndex = 0,
    uint PageSize = 100,
    int ComboBoostMultiplier = 100,
    uint MinComboCount = 3);

public sealed record FffGrepOptions(
    FffGrepMode Mode = FffGrepMode.Fuzzy,
    ulong MaxFileSize = 0,
    uint MaxMatchesPerFile = 100,
    bool SmartCase = true,
    uint FileOffset = 0,
    uint PageLimit = 100,
    ulong TimeBudgetMs = 30,
    uint BeforeContext = 0,
    uint AfterContext = 0,
    bool ClassifyDefinitions = false);

public sealed record FffFileItem(
    string RelativePath,
    string FileName,
    string? GitStatus,
    ulong Size,
    ulong Modified,
    long TotalFrecencyScore,
    long AccessFrecencyScore,
    long ModificationFrecencyScore,
    bool IsBinary);

public sealed record FffFileSearchResult(
    IReadOnlyList<FffFileItem> Items,
    uint TotalMatched,
    uint TotalFiles);

public sealed record FffGrepMatch(
    string RelativePath,
    string FileName,
    string? GitStatus,
    string LineContent,
    ulong LineNumber,
    uint Column,
    ulong ByteOffset,
    ulong Size,
    ulong Modified,
    long TotalFrecencyScore,
    long AccessFrecencyScore,
    long ModificationFrecencyScore,
    bool IsDefinition,
    bool IsBinary);

public sealed record FffGrepResult(
    IReadOnlyList<FffGrepMatch> Matches,
    uint TotalMatched,
    uint TotalFilesSearched,
    uint TotalFiles,
    uint FilteredFileCount,
    uint NextFileOffset,
    string? RegexFallbackError);

public sealed class FffNativeException : Exception
{
    public FffNativeException(string message)
        : base(message)
    {
    }
}
