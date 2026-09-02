// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Editor;

/// <summary>
/// "Seeky: Document Outline" command — shows the Seeky modal search window in outline mode:
/// every declaration in the active document, indented by nesting, the symbol enclosing the
/// caret preselected. Arrows walk the file, typing fuzzy-filters, Enter jumps to the selected
/// declaration.
/// </summary>
[VisualStudioContribution]
public class SeekySymbolPathCommand : Command
{
    /// <inheritdoc />
    public override CommandConfiguration CommandConfiguration => new("%SeekyVS.SeekySymbolPathCommand.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ToolsMenu],
        Icon = new(ImageMoniker.KnownValues.Method, IconSettings.IconAndText),

        // Matches the sibling commands' Ctrl+Shift+Alt family (B for breadcrumbs); rebindable
        // under Tools → Options → Keyboard.
        Shortcuts = [new CommandShortcutConfiguration(ModifierKey.ControlShiftLeftAlt, Key.B)],
    };

    /// <inheritdoc />
    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        SeekyLog.Info("'Seeky: Symbol Path' command invoked (declared default shortcut Ctrl+Shift+Alt+B)");
        SymbolPathRequest? request = null;
        try
        {
            // Read before showing: the popup takes focus, and the active text view goes with it.
            using ITextViewSnapshot? textView =
                await this.Extensibility.Editor().GetActiveTextViewAsync(context, cancellationToken);
            if (textView is not null)
            {
                // LineNumber is 0-origin; the picker and fff speak 1-based lines.
                int caretLine = textView.Selection.InsertionPosition.GetContainingLine().LineNumber + 1;
                var lines = new List<string>();
                foreach (ITextDocumentSnapshotLine line in textView.Document.Lines)
                {
                    lines.Add(EditorWord.RangeToString(line.Text, int.MaxValue));
                }

                string documentPath = textView.Document.Uri is Uri uri && uri.IsFile
                    ? uri.LocalPath
                    : string.Empty;
                var outline = SymbolOutline.ClassifyAll(documentPath, lines);
                SeekyLog.Info($"Document outline: {outline.Count} symbols in '{documentPath}' (caret line {caretLine})");
                request = new SymbolPathRequest(documentPath, caretLine, outline);
            }
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Building the symbol path failed", ex);
        }

        try
        {
            // A null request still opens the popup — an empty list with a status line beats a
            // shortcut that silently does nothing when no editor is active.
            await SeekyModalWindowManager.ShowAsync(this.Extensibility, context, "path", pathRequest: request);
            SeekyLog.Info("ShowAsync completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Command failed while showing the modal window", ex);
        }
    }
}
