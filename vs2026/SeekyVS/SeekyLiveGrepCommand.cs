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
    /// <summary>
    /// Creates the command. The dependency exists so DI creates the pipe server when the
    /// shell activates the commands at startup — that is what starts the pipe NeoVS uses.
    /// </summary>
    public SeekyLiveGrepCommand(RemoteControlServer remoteControl)
    {
        _ = remoteControl;
    }

    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekyLiveGrepCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Search, IconSettings.IconAndText),

        // Default keybinding (chosen so the NeoVS companion never sees it: Ctrl+Alt
        // chords are AltGr territory and always pass through to Visual Studio).
        // Rebindable under Tools → Options → Keyboard (by display name).
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShiftLeftAlt, Key.I)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Live Grep' command invoked (declared default shortcut Ctrl+Shift+Alt+I)");
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
