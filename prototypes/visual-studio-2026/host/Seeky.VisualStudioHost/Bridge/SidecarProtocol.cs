using System.Text.Json;

namespace Seeky.VisualStudioHost.Bridge;

public static class SeekySidecarModes
{
    public const string Files = "files";
    public const string Grep = "grep";
}

public static class SeekyGrepModes
{
    public const string Fuzzy = "fuzzy";
    public const string Plain = "plain";
    public const string Regex = "regex";
}

public sealed record SidecarPingRequest(string RequestId, string Type = "ping");

public sealed record SidecarInitRequest(
    string RequestId,
    string WorkspacePath,
    string? StoragePath,
    string Type = "init");

public sealed record SidecarDisposeRequest(
    string RequestId,
    string WorkspacePath,
    string Type = "dispose");

public sealed record SidecarCancelRequest(string RequestId, string Type = "cancel");

public sealed record SidecarSearchRequest(
    string RequestId,
    string WorkspacePath,
    string Mode,
    string Query,
    string? GrepMode = null,
    int MaxResults = 100,
    string? CurrentFile = null,
    string? StoragePath = null,
    string Type = "search");

public sealed record SidecarSearchResultItem(
    string Type,
    string File,
    string RelativePath,
    int? Line,
    int? Col,
    string? Text,
    double? FrecencyScore);

public sealed record SidecarSearchCompleted(int Count, double? DurationMs);

public sealed record SidecarEnvelope(
    string Type,
    string RequestId,
    JsonElement? Item = null,
    string? Message = null,
    int? Count = null,
    double? DurationMs = null);
