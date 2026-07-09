using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.Extensibility;
using Seeky.FffNative;

namespace VSSeeky;

internal sealed class SeekySearchService : IDisposable
{
    private readonly VisualStudioExtensibility extensibility;
    private readonly SemaphoreSlim gate = new(1, 1);
    private FffSession? session;
    private string? sessionWorkspacePath;
    private bool initialScanCompleted;

    public SeekySearchService(VisualStudioExtensibility extensibility)
    {
        this.extensibility = extensibility;
    }

    public async Task<SeekySearchResponse> SearchAsync(
        string workspacePath,
        string mode,
        string query,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workspacePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(query);

        var normalizedWorkspacePath = Path.GetFullPath(workspacePath.Trim());
        if (!Directory.Exists(normalizedWorkspacePath))
        {
            throw new DirectoryNotFoundException($"Workspace path does not exist: {normalizedWorkspacePath}");
        }

        await this.gate.WaitAsync(cancellationToken);
        try
        {
            await this.EnsureSessionAsync(normalizedWorkspacePath, cancellationToken);
            return mode.Equals("grep", StringComparison.OrdinalIgnoreCase)
                ? await this.SearchGrepAsync(query, cancellationToken)
                : await this.SearchFilesAsync(query, cancellationToken);
        }
        finally
        {
            this.gate.Release();
        }
    }

    public async Task OpenResultAsync(SeekySearchResult result, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(result);

        await this.extensibility.Documents().OpenDocumentAsync(
            new Uri(result.FilePath, UriKind.Absolute),
            cancellationToken);
    }

    public void Dispose()
    {
        this.session?.Dispose();
        this.session = null;
        this.gate.Dispose();
    }

    private async Task EnsureSessionAsync(string workspacePath, CancellationToken cancellationToken)
    {
        if (this.session is not null
            && string.Equals(this.sessionWorkspacePath, workspacePath, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        this.session?.Dispose();

        var storageDirectory = GetStorageDirectory(workspacePath);
        Directory.CreateDirectory(storageDirectory);

        this.session = await Task.Run(() => FffSession.Create(new FffCreateOptions(
            BasePath: workspacePath,
            FrecencyDbPath: Path.Combine(storageDirectory, "frecency.db"),
            HistoryDbPath: Path.Combine(storageDirectory, "history.db"))), cancellationToken);

        this.initialScanCompleted = await Task.Run(
            () => this.session.WaitForScan(TimeSpan.FromSeconds(10)),
            cancellationToken);
        this.sessionWorkspacePath = workspacePath;
    }

    private async Task<SeekySearchResponse> SearchFilesAsync(string query, CancellationToken cancellationToken)
    {
        var searchResult = await Task.Run(
            () => this.session!.SearchFiles(query, new FffFileSearchOptions(PageSize: 100)),
            cancellationToken);

        var results = searchResult.Items
            .Select(item => new SeekySearchResult(
                FilePath: Path.Combine(this.sessionWorkspacePath!, item.RelativePath),
                PrimaryText: item.RelativePath,
                SecondaryText: $"{item.TotalFrecencyScore} frecency",
                Line: null,
                Column: null))
            .ToArray();

        return new SeekySearchResponse(
            Results: results,
            StatusText: $"{results.Length} file result(s), {searchResult.TotalMatched} matched, {searchResult.TotalFiles} indexed{GetScanSuffix()}");
    }

    private async Task<SeekySearchResponse> SearchGrepAsync(string query, CancellationToken cancellationToken)
    {
        var grepResult = await Task.Run(
            () => this.session!.SearchGrep(query, new FffGrepOptions(PageLimit: 100)),
            cancellationToken);

        var results = grepResult.Matches
            .Select(match => new SeekySearchResult(
                FilePath: Path.Combine(this.sessionWorkspacePath!, match.RelativePath),
                PrimaryText: $"{match.RelativePath}:{match.LineNumber}:{match.Column}",
                SecondaryText: match.LineContent.Trim(),
                Line: checked((uint)match.LineNumber),
                Column: match.Column))
            .ToArray();

        var regexSuffix = string.IsNullOrWhiteSpace(grepResult.RegexFallbackError)
            ? string.Empty
            : $" Regex fallback: {grepResult.RegexFallbackError}";

        return new SeekySearchResponse(
            Results: results,
            StatusText: $"{results.Length} grep result(s), {grepResult.TotalMatched} matched, {grepResult.TotalFilesSearched} searched of {grepResult.TotalFiles} indexed{GetScanSuffix()}{regexSuffix}");
    }

    private string GetScanSuffix()
    {
        return this.initialScanCompleted ? string.Empty : " (initial scan still warming up)";
    }

    private static string GetStorageDirectory(string workspacePath)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var workspaceHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(workspacePath)));
        return Path.Combine(localAppData, "Seeky", "VisualStudioPrototype", workspaceHash);
    }
}

internal sealed record SeekySearchResult(
    string FilePath,
    string PrimaryText,
    string SecondaryText,
    uint? Line,
    uint? Column);

internal sealed record SeekySearchResponse(
    IReadOnlyList<SeekySearchResult> Results,
    string StatusText);
