// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.ToolWindows;
using Microsoft.VisualStudio.RpcContracts.RemoteUI;

/// <summary>
/// The Seeky search tool window. Its content is a Remote UI control hosting a WebView2.
/// </summary>
[VisualStudioContribution]
public class SeekyToolWindow : ToolWindow
{
    private readonly SeekyToolWindowContent _content = new(dataContext: null);

    /// <summary>
    /// Initializes a new instance of the <see cref="SeekyToolWindow"/> class.
    /// </summary>
    public SeekyToolWindow()
    {
        Title = "Seeky";
    }

    /// <inheritdoc />
    public override ToolWindowConfiguration ToolWindowConfiguration => new()
    {
        Placement = ToolWindowPlacement.DocumentWell,
        DockDirection = Dock.None,
        AllowAutoCreation = true,
    };

    /// <inheritdoc />
    public override Task<IRemoteUserControl> GetContentAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IRemoteUserControl>(_content);
    }

    /// <inheritdoc />
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _content.Dispose();
        }

        base.Dispose(disposing);
    }
}
