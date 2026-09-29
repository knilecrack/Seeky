// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

/// <summary>
/// "Seeky: Grep Word Under Cursor" — opens the modal search window in live-grep mode, pre-filled
/// with the editor's selection, or with the identifier the caret is sitting on.
/// </summary>
/// <remarks>
/// The grep sub-mode is deliberately left alone rather than forced to plain: it is a persisted
/// user preference now (see <see cref="SeekyState"/>), and fuzzy matching an exact identifier
/// still ranks that identifier first, so overriding it would cost more than it buys.
/// </remarks>
[VisualStudioContribution]
public class SeekyGrepWordCommand : Command
{
    /// <summary>
    /// Creates the command. The dependency exists so DI creates the pipe server when the
    /// shell activates the commands at startup — that is what starts the pipe NeoVS uses.
    /// </summary>
    public SeekyGrepWordCommand(RemoteControlServer remoteControl)
    {
        _ = remoteControl;
    }

    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekyGrepWordCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new CommandIconConfiguration(ImageMoniker.KnownValues.Search, IconSettings.IconAndText),

        // All four Seeky commands sit on the Ctrl+Shift+Alt family: NeoVS never claims
        // Ctrl+Alt chords, so they always reach Visual Studio's command system.
        // Rebindable under Tools → Options → Keyboard.
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShiftLeftAlt, Key.G)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Grep Word Under Cursor' command invoked (declared default shortcut Ctrl+Shift+Alt+G)");
        try
        {
            // Read before showing: the popup takes focus, and the active text view goes with it.
            string? term = await EditorWord.GetSearchTermAsync(this.Extensibility, context, cancellationToken);
            SeekyLog.Info($"Grep word: term '{term ?? "(none)"}'");

            // A null term still opens the popup — an empty grep prompt is a better outcome than
            // a shortcut that silently does nothing when the caret is on whitespace.
            await SeekyModalWindowManager.ShowAsync(this.Extensibility, context, "grep", term);
            SeekyLog.Info("ShowAsync completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Command failed while showing the modal window", ex);
        }
    }
}
