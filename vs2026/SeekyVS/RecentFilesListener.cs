// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Editor;

/// <summary>
/// Records every text document VS opens — Solution Explorer, Go To Definition, anything, not just
/// Seeky picks — into <see cref="RecentFiles"/>, which Find Files lists on an empty prompt.
/// </summary>
/// <remarks>
/// Opens only: the extensibility SDK raises no event when the user merely switches between tabs
/// that are already open. The popup covers part of that gap by touching the active document
/// whenever Find Files opens.
/// </remarks>
[VisualStudioContribution]
internal sealed class RecentFilesListener : ExtensionPart, ITextViewOpenClosedListener
{
    /// <inheritdoc />
    public TextViewExtensionConfiguration TextViewExtensionConfiguration => new()
    {
        AppliesTo = [DocumentFilter.FromDocumentType(DocumentType.KnownValues.Text)],
    };

    /// <inheritdoc />
    public Task TextViewOpenedAsync(ITextViewSnapshot textView, CancellationToken cancellationToken)
    {
        if (textView.Document.Uri is Uri uri && uri.IsFile)
        {
            RecentFiles.Touch(uri.LocalPath);
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task TextViewClosedAsync(ITextViewSnapshot textView, CancellationToken cancellationToken) =>
        Task.CompletedTask;
}
