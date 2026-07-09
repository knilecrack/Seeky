using System.Runtime.Serialization;
using Microsoft.VisualStudio.Extensibility.UI;

namespace VSSeeky;

[DataContract]
internal sealed class SeekyToolWindowData : NotifyPropertyChangedObject
{
    private readonly SeekySearchService searchService;
    private string workspacePath = string.Empty;
    private string query = string.Empty;
    private string selectedSearchMode = "files";
    private SeekySearchResultItem[] searchResults = [];
    private string statusText = "Ready.";

    public SeekyToolWindowData(SeekySearchService searchService, string? initialWorkspacePath = null)
    {
        this.searchService = searchService;
        this.workspacePath = initialWorkspacePath ?? string.Empty;
        this.statusText = string.IsNullOrWhiteSpace(initialWorkspacePath)
            ? "Ready. No workspace was auto-detected."
            : $"Ready. Auto-detected workspace: {initialWorkspacePath}";
        this.SearchCommand = new AsyncCommand(this.SearchAsync);
    }

    [DataMember]
    public IAsyncCommand SearchCommand { get; }

    [DataMember]
    public string[] SearchModes { get; } = ["files", "grep"];

    [DataMember]
    public string WorkspacePath
    {
        get => this.workspacePath;
        set => this.SetProperty(ref this.workspacePath, value);
    }

    [DataMember]
    public string Query
    {
        get => this.query;
        set => this.SetProperty(ref this.query, value);
    }

    [DataMember]
    public string SelectedSearchMode
    {
        get => this.selectedSearchMode;
        set => this.SetProperty(ref this.selectedSearchMode, value);
    }

    [DataMember]
    public SeekySearchResultItem[] SearchResults
    {
        get => this.searchResults;
        set => this.SetProperty(ref this.searchResults, value);
    }

    [DataMember]
    public string StatusText
    {
        get => this.statusText;
        set => this.SetProperty(ref this.statusText, value);
    }

    private async Task SearchAsync(object? commandParameter, CancellationToken cancellationToken)
    {
        this.StatusText = "Searching...";

        try
        {
            var response = await this.searchService.SearchAsync(
                this.WorkspacePath,
                this.SelectedSearchMode,
                this.Query,
                cancellationToken);

            this.SearchResults = response.Results
                .Select(result => new SeekySearchResultItem(result, this.searchService))
                .ToArray();
            this.StatusText = response.StatusText;
        }
        catch (Exception ex)
        {
            this.SearchResults = [];
            this.StatusText = ex.Message;
        }
    }
}

[DataContract]
internal sealed class SeekySearchResultItem
{
    private readonly SeekySearchResult result;
    private readonly SeekySearchService searchService;

    public SeekySearchResultItem(SeekySearchResult result, SeekySearchService searchService)
    {
        this.result = result;
        this.searchService = searchService;
        this.OpenCommand = new AsyncCommand(this.OpenAsync);
    }

    [DataMember]
    public string PrimaryText => this.result.PrimaryText;

    [DataMember]
    public string SecondaryText => this.result.SecondaryText;

    [DataMember]
    public IAsyncCommand OpenCommand { get; }

    private async Task OpenAsync(object? commandParameter, CancellationToken cancellationToken)
    {
        await this.searchService.OpenResultAsync(this.result, cancellationToken);
    }
}
