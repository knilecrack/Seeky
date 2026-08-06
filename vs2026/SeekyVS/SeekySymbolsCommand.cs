// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

/// <summary>
/// "Seeky: Symbols" command — shows the Seeky modal search window (raw Win32 + WebView2) in the
/// workspace-symbols mode: fuzzy search over the workspace's declarations (types, methods,
/// properties, fields; see <see cref="SymbolIndex"/>).
/// </summary>
[VisualStudioContribution]
public class SeekySymbolsCommand : Command
{
    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekySymbolsCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Method, IconSettings.IconAndText),

        // Matches the sibling commands' Ctrl+Shift(+Alt) family; rebindable under
        // Tools → Options → Keyboard.
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShiftLeftAlt, Key.O)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Symbols' command invoked (declared default shortcut Ctrl+Shift+Alt+O)");
        try
        {
            await SeekyModalWindowManager.ShowAsync(this.Extensibility, context, "symbols");
            SeekyLog.Info("ShowAsync completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Command failed while showing the modal window", ex);
        }
    }
}
