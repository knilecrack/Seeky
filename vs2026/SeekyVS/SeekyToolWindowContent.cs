// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility.UI;

/// <summary>
/// Remote user control hosting the Seeky WebView2 UI.
/// </summary>
/// <remarks>
/// Remote UI XAML is parsed in the Visual Studio process, which cannot reference types from this
/// extension. The XAML therefore references WebView2 by assembly name and relies on Visual Studio
/// shipping the WebView2 WPF assemblies. Because the XAML is static, this control substitutes one
/// placeholder at runtime (see <see cref="GetXamlAsync"/>): <c>__SEEKY_INDEX_URI__</c> — the file://
/// URI of WebUI/index.html deployed next to this assembly.
/// </remarks>
internal class SeekyToolWindowContent : RemoteUserControl
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SeekyToolWindowContent"/> class.
    /// </summary>
    /// <param name="dataContext">Data context of the remote control.</param>
    public SeekyToolWindowContent(object? dataContext)
        : base(dataContext)
    {
    }

    /// <inheritdoc />
    public override async Task<string> GetXamlAsync(CancellationToken cancellationToken)
    {
        string xaml = await base.GetXamlAsync(cancellationToken).ConfigureAwait(false);

        string extensionDir = Path.GetDirectoryName(typeof(SeekyToolWindowContent).Assembly.Location)
            ?? AppContext.BaseDirectory;
        string indexUri = new Uri(Path.Combine(extensionDir, "WebUI", "index.html")).AbsoluteUri;

        return xaml.Replace("__SEEKY_INDEX_URI__", indexUri, StringComparison.Ordinal);
    }
}
