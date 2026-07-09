using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;

namespace Seeky.FffNative;

public static class FffNativeLibrary
{
    private static readonly object Sync = new();
    private static string? _configuredLibraryPath;
    private static nint _loadedHandle;

    static FffNativeLibrary()
    {
        NativeLibrary.SetDllImportResolver(typeof(FffNativeLibrary).Assembly, ResolveLibrary);
    }

    public static void ConfigureLibraryPath(string libraryPath)
    {
        if (string.IsNullOrWhiteSpace(libraryPath))
        {
            throw new ArgumentException("Library path must not be empty.", nameof(libraryPath));
        }

        lock (Sync)
        {
            _configuredLibraryPath = libraryPath;
        }
    }

    internal static void EnsureResolverRegistered()
    {
        RuntimeHelpers.RunClassConstructor(typeof(FffNativeLibrary).TypeHandle);
    }

    private static nint ResolveLibrary(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, NativeMethods.LibraryName, StringComparison.Ordinal))
        {
            return nint.Zero;
        }

        lock (Sync)
        {
            if (_loadedHandle != nint.Zero)
            {
                return _loadedHandle;
            }

            foreach (var candidate in GetCandidates())
            {
                if (NativeLibrary.TryLoad(candidate, assembly, searchPath, out var handle))
                {
                    _loadedHandle = handle;
                    return handle;
                }
            }

            throw new DllNotFoundException(
                $"Unable to load {GetPlatformLibraryFileName()}. Configure the path with {nameof(ConfigureLibraryPath)} or set SEEKY_FFF_NATIVE_PATH.");
        }
    }

    private static IEnumerable<string> GetCandidates()
    {
        var fileName = GetPlatformLibraryFileName();
        var envPath = Environment.GetEnvironmentVariable("SEEKY_FFF_NATIVE_PATH");

        if (!string.IsNullOrWhiteSpace(_configuredLibraryPath))
        {
            yield return NormalizeCandidate(_configuredLibraryPath!, fileName);
        }

        if (!string.IsNullOrWhiteSpace(envPath))
        {
            yield return NormalizeCandidate(envPath, fileName);
        }

        yield return Path.Combine(AppContext.BaseDirectory, fileName);
        yield return Path.Combine(AppContext.BaseDirectory, "runtimes", GetRuntimeIdentifier(), "native", fileName);
        yield return fileName;
    }

    private static string NormalizeCandidate(string path, string fileName)
    {
        if (Directory.Exists(path))
        {
            return Path.Combine(path, fileName);
        }

        return path;
    }

    private static string GetPlatformLibraryFileName()
    {
        if (OperatingSystem.IsWindows())
        {
            return "fff_c.dll";
        }

        if (OperatingSystem.IsMacOS())
        {
            return "libfff_c.dylib";
        }

        return "libfff_c.so";
    }

    private static string GetRuntimeIdentifier()
    {
        if (OperatingSystem.IsWindows())
        {
            return RuntimeInformation.OSArchitecture switch
            {
                Architecture.Arm64 => "win-arm64",
                _ => "win-x64",
            };
        }

        if (OperatingSystem.IsMacOS())
        {
            return RuntimeInformation.OSArchitecture switch
            {
                Architecture.Arm64 => "osx-arm64",
                _ => "osx-x64",
            };
        }

        return RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "linux-arm64",
            _ => "linux-x64",
        };
    }
}
