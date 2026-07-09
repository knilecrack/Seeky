using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.ProjectSystem.Query;

namespace VSSeeky;

internal static class SeekyWorkspaceResolver
{
    public static async Task<string?> ResolveWorkspacePathAsync(
        VisualStudioExtensibility extensibility,
        CancellationToken cancellationToken)
    {
        var projects = await extensibility.Workspaces().QueryProjectsAsync(
            project => project.With(p => p.Path),
            cancellationToken);

        var projectPaths = projects
            .Select(project => project.Path)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => Path.GetDirectoryName(path!))
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => Path.GetFullPath(path!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (projectPaths.Length == 0)
        {
            return null;
        }

        if (projectPaths.Length == 1)
        {
            return projectPaths[0];
        }

        return GetCommonDirectory(projectPaths);
    }

    private static string GetCommonDirectory(IReadOnlyList<string> paths)
    {
        var candidate = Path.GetFullPath(paths[0]);

        while (!string.IsNullOrEmpty(candidate))
        {
            if (paths.All(path => path.StartsWith(candidate, StringComparison.OrdinalIgnoreCase)))
            {
                return candidate.TrimEnd(Path.DirectorySeparatorChar);
            }

            candidate = Path.GetDirectoryName(candidate) ?? string.Empty;
        }

        return Path.GetPathRoot(paths[0]) ?? paths[0];
    }
}
