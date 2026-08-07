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
    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekyGrepWordCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Search, IconSettings.IconAndText),

        // Ctrl+Shift+G is plain Live Grep; this is the same family with the Alt the other two
        // Seeky commands already use. Rebindable under Tools → Options → Keyboard.
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
