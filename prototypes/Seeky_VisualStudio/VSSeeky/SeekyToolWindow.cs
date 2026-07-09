using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.ToolWindows;
using Microsoft.VisualStudio.RpcContracts.RemoteUI;

namespace VSSeeky;

[VisualStudioContribution]
internal sealed class SeekyToolWindow : ToolWindow
{
    private readonly SeekySearchService searchService;
    private SeekyToolWindowData? dataContext;

    public SeekyToolWindow(SeekySearchService searchService)
    {
        this.searchService = searchService;
        this.Title = "Seeky";
    }

    public override ToolWindowConfiguration ToolWindowConfiguration => new()
    {
        Placement = ToolWindowPlacement.Floating,
        AllowAutoCreation = false,
    };

    public override async Task InitializeAsync(CancellationToken cancellationToken)
    {
        var workspacePath = await SeekyWorkspaceResolver.ResolveWorkspacePathAsync(this.Extensibility, cancellationToken);
        this.dataContext = new SeekyToolWindowData(this.searchService, workspacePath);
    }

    public override Task<IRemoteUserControl> GetContentAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IRemoteUserControl>(new SeekyToolWindowControl(this.dataContext));
    }
}
