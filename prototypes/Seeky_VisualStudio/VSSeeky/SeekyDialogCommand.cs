using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace VSSeeky;

[VisualStudioContribution]
internal sealed class SeekyDialogCommand : Command
{
    private readonly SeekySearchService searchService;

    public SeekyDialogCommand(SeekySearchService searchService)
    {
        this.searchService = searchService;
    }

    public override CommandConfiguration CommandConfiguration => new("%VSSeeky.OpenSeekyDialog.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Search, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        var workspacePath = await SeekyWorkspaceResolver.ResolveWorkspacePathAsync(this.Extensibility, cancellationToken);
        var data = new SeekyToolWindowData(this.searchService, workspacePath);

#pragma warning disable CA2000
        var control = new SeekyToolWindowControl(data);
#pragma warning restore CA2000

        await this.Extensibility.Shell().ShowDialogAsync(control, "Seeky", cancellationToken);
    }
}
