// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.VisualStudio.Extensibility;

/// <summary>
/// Extension entry point for SeekyVS.
/// </summary>
[VisualStudioContribution]
public class SeekyVSExtension : Extension
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SeekyVSExtension"/> class. This is the earliest
    /// hook we get — its log line proves the extension assembly loaded in the out-of-proc host.
    /// </summary>
    public SeekyVSExtension()
    {
        SeekyLog.Info($"SeekyVSExtension ctor — extension loaded (pid {Environment.ProcessId}, process '{Process.GetCurrentProcess().ProcessName}')");

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            SeekyLog.Error("AppDomain unhandled exception", e.ExceptionObject as Exception ?? new Exception(Convert.ToString(e.ExceptionObject)));
        TaskScheduler.UnobservedTaskException += (_, e) =>
            SeekyLog.Error("Unobserved task exception", e.Exception);
    }

    /// <inheritdoc/>
    public override ExtensionConfiguration ExtensionConfiguration => new()
    {
        Metadata = new(
                id: "SeekyVS.3f6b2d8a-9c41-4e7b-b2a1-5d8f0c6e4a92",
                version: this.ExtensionAssemblyVersion,
                publisherName: "knilecrack",
                displayName: "Seeky",
                description: "Telescope-inspired keyboard-driven search for Visual Studio (spike port of the Seeky VS Code extension)")
        {
            // VS 2026-only extension: declare the net10 host (otherwise the manifest generator
            // defaults to net8.0 and VS would load this net10 assembly with the wrong host).
            DotnetTargetVersions = new[] { DotnetTarget.Custom("net10.0") },
        },
    };

    /// <inheritdoc/>
    protected override void InitializeServices(IServiceCollection serviceCollection)
    {
        SeekyLog.Info("InitializeServices");
        base.InitializeServices(serviceCollection);
    }

    /// <inheritdoc/>
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SeekyModalWindowManager.Shutdown();
        }

        base.Dispose(disposing);
    }
}
