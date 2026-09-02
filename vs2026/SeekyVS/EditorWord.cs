// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Editor;

/// <summary>
/// Pulls the search term out of the active editor: the selected text if there is a selection,
/// otherwise the identifier under the caret.
/// </summary>
internal static class EditorWord
{
    /// <summary>
    /// Longest term taken from the editor. A grep query is a line-oriented pattern, and a stray
    /// Ctrl+A before the shortcut should not push a whole file through fff.
    /// </summary>
    private const int MaxLength = 200;

    /// <summary>
    /// The active editor's search term, or null when there is no editor, no term, or the query
    /// failed. Never throws — the caller opens an empty popup instead.
    /// </summary>
    /// <remarks>
    /// Safe to await directly from a command: <c>ExecuteCommandAsync</c> does not run on the
    /// popup's Win32 pump, which is the thread where editor RPC deadlocks (see
    /// <c>GetActiveDocumentRelativePathAsync</c>, which has to hop to the thread pool for exactly
    /// that reason).
    /// </remarks>
    internal static async Task<string?> GetSearchTermAsync(
        VisualStudioExtensibility extensibility, IClientContext clientContext, CancellationToken cancellationToken)
    {
        try
        {
            using ITextViewSnapshot? textView =
                await extensibility.Editor().GetActiveTextViewAsync(clientContext, cancellationToken);
            if (textView is null)
            {
                return null;
            }

            Selection selection = textView.Selection;

            // A selection wins over the caret: if the user highlighted something, that is
            // unambiguously what they want searched, word boundaries or not.
            if (!selection.IsEmpty)
            {
                return Normalize(RangeToString(selection.Extent, MaxLength));
            }

            TextPosition caret = selection.InsertionPosition;
            ITextDocumentSnapshotLine line = caret.GetContainingLine();
            string lineText = RangeToString(line.Text, int.MaxValue);
            return Normalize(WordAt(lineText, caret.Offset - line.Text.Start.Offset));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Reading the editor's search term failed", ex);
            return null;
        }
    }

    /// <summary>
    /// The identifier spanning <paramref name="column"/> in <paramref name="line"/>, or an empty
    /// string when the caret is not touching one.
    /// </summary>
    /// <remarks>
    /// Expands in both directions, so a caret resting just past the end of a word — where it lands
    /// after double-clicking or arrowing to the end of an identifier — still picks that word up
    /// rather than the whitespace after it.
    /// </remarks>
    internal static string WordAt(string line, int column)
    {
        if (line.Length == 0)
        {
            return string.Empty;
        }

        column = Math.Clamp(column, 0, line.Length);
        int start = column;
        while (start > 0 && IsWordChar(line[start - 1]))
        {
            start--;
        }

        int end = column;
        while (end < line.Length && IsWordChar(line[end]))
        {
            end++;
        }

        return end > start ? line[start..end] : string.Empty;
    }

    /// <summary>
    /// Identifier characters, which is what makes a "word" worth grepping for. Deliberately not
    /// dotted paths or kebab-case: those would swallow the surrounding expression.
    /// </summary>
    private static bool IsWordChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    /// <summary>
    /// Trims the term and collapses it to its first line. A multi-line selection cannot be a grep
    /// pattern, and taking the first line is closer to intent than refusing outright.
    /// </summary>
    private static string? Normalize(string term)
    {
        int lineBreak = term.AsSpan().IndexOfAny('\r', '\n');
        if (lineBreak >= 0)
        {
            term = term[..lineBreak];
        }

        term = term.Trim();
        return term.Length == 0 ? null : term;
    }

    internal static string RangeToString(TextRange range, int maxLength)
    {
        int length = Math.Min(range.Length, maxLength);
        if (length <= 0)
        {
            return string.Empty;
        }

        // One bulk copy rather than the char indexer: these snapshots sit behind an RPC contract,
        // and per-character access across it is not a cost worth discovering later.
        char[] buffer = new char[range.Length];
        range.CopyTo(buffer);
        return new string(buffer, 0, length);
    }
}
