
using Microsoft.Extensions.DependencyInjection;
using Microsoft.VisualStudio.Extensibility;
using Seeky.FffNative;

namespace VSSeeky;
/// <summary>
/// Extension entrypoint for the VisualStudio.Extensibility extension.
/// </summary>
[VisualStudioContribution]
internal class ExtensionEntrypoint : Extension
{
    /// <inheritdoc/>
    public override ExtensionConfiguration ExtensionConfiguration => new()
    {
        Metadata = new(
                id: "VSSeeky.2d817a43-66eb-48b6-8d88-f26b3018cc56",
                version: this.ExtensionAssemblyVersion,
                publisherName: "knilecrack",
                displayName: "Seeky Visual Studio Prototype",
                description: "Prototype VisualStudio.Extensibility host for Seeky using the native FFF wrapper."),
    };

    /// <inheritdoc />
    protected override void InitializeServices(IServiceCollection serviceCollection)
    {
        base.InitializeServices(serviceCollection);
        var extensionDirectory = Path.GetDirectoryName(typeof(ExtensionEntrypoint).Assembly.Location);
        if (!string.IsNullOrWhiteSpace(extensionDirectory))
        {
            FffNativeLibrary.ConfigureLibraryPath(extensionDirectory);
        }

        serviceCollection.AddSingleton<SeekySearchService>();
    }
}
