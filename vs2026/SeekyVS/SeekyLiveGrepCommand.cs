// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

/// <summary>
/// "Seeky: Live Grep" command — shows the Seeky modal search window (raw Win32 + WebView2)
/// in the live-grep mode.
/// </summary>
[VisualStudioContribution]
public class SeekyLiveGrepCommand : Command
{
    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekyLiveGrepCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Search, IconSettings.IconAndText),

        // Default keybinding (mirrors the VS Code Seeky extension); users can rebind under
        // Tools → Options → Keyboard (the command shows up there by its display name).
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShift, Key.G)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Live Grep' command invoked (declared default shortcut Ctrl+Shift+G)");
        try
        {
            await SeekyModalWindowManager.ShowAsync(this.Extensibility, context, "grep");
            SeekyLog.Info("ShowAsync completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Command failed while showing the modal window", ex);
        }
    }
}
