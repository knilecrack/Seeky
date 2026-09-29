// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

/// <summary>
/// "Seeky: Resume Last Search" command — re-shows the Seeky popup exactly as it was left: mode,
/// query, results, selection and scroll (Telescope's <c>resume</c>). The popup is only ever hidden
/// between uses, so this is a show without the usual reset.
/// </summary>
[VisualStudioContribution]
public class SeekyResumeCommand : Command
{
    /// <summary>
    /// Creates the command. The dependency exists so DI creates the pipe server when the
    /// shell activates the commands at startup — that is what starts the pipe NeoVS uses.
    /// </summary>
    public SeekyResumeCommand(RemoteControlServer remoteControl)
    {
        _ = remoteControl;
    }

    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekyResumeCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Refresh, IconSettings.IconAndText),

        // Default keybinding (chosen so the NeoVS companion never sees it: Ctrl+Alt
        // chords are AltGr territory and always pass through to Visual Studio).
        // Rebindable under Tools → Options → Keyboard (by display name).
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShiftLeftAlt, Key.W)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Resume Last Search' command invoked (declared default shortcut Ctrl+Shift+Alt+W)");
        try
        {
            await SeekyModalWindowManager.ShowAsync(this.Extensibility, context, "resume");
            SeekyLog.Info("ShowAsync completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Command failed while showing the modal window", ex);
        }
    }
}
