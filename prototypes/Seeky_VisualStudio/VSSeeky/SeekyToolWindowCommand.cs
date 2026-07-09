using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace VSSeeky;

[VisualStudioContribution]
internal sealed class SeekyToolWindowCommand : Command
{
    public override CommandConfiguration CommandConfiguration => new("%VSSeeky.OpenSeekyToolWindow.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.ToolWindow, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        await this.Extensibility.Shell().ShowToolWindowAsync<SeekyToolWindow>(activate: true, cancellationToken);
    }
}
