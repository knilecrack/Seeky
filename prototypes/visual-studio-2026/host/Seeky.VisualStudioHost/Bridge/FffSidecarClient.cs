using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Seeky.VisualStudioHost.Bridge;

public sealed class FffSidecarClient : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly ConcurrentDictionary<string, TaskCompletionSource<SidecarEnvelope>> _pendingRequests = new();
    private readonly ConcurrentDictionary<string, SearchStreamState> _searchStreams = new();
    private readonly string _nodeExecutablePath;
    private readonly string _scriptPath;

    private Process? _process;
    private Task? _stdoutLoop;
    private Task? _stderrLoop;

    public FffSidecarClient(string nodeExecutablePath, string scriptPath)
    {
        _nodeExecutablePath = nodeExecutablePath;
        _scriptPath = scriptPath;
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_process is not null)
        {
            return;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = _nodeExecutablePath,
            Arguments = $"\"{_scriptPath}\"",
            WorkingDirectory = Path.GetDirectoryName(_scriptPath) ?? Environment.CurrentDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = Encoding.UTF8,
        };

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        process.Exited += (_, _) =>
        {
            var ex = new InvalidOperationException("Seeky sidecar exited unexpectedly.");

            foreach (var pending in _pendingRequests.Values)
            {
                pending.TrySetException(ex);
            }

            foreach (var stream in _searchStreams.Values)
            {
                stream.Completion.TrySetException(ex);
            }
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start Seeky sidecar process.");
        }

        _process = process;
        _stdoutLoop = Task.Run(ReadStdoutLoopAsync, cancellationToken);
        _stderrLoop = Task.Run(ReadStderrLoopAsync, cancellationToken);

        await PingAsync(cancellationToken);
    }

    public async Task PingAsync(CancellationToken cancellationToken = default)
    {
        var request = new SidecarPingRequest(Guid.NewGuid().ToString("N"));
        await SendRequestAsync(request, cancellationToken);
    }

    public async Task InitializeWorkspaceAsync(string workspacePath, string? storagePath, CancellationToken cancellationToken = default)
    {
        var request = new SidecarInitRequest(Guid.NewGuid().ToString("N"), workspacePath, storagePath);
        await SendRequestAsync(request, cancellationToken);
    }

    public async Task DisposeWorkspaceAsync(string workspacePath, CancellationToken cancellationToken = default)
    {
        var request = new SidecarDisposeRequest(Guid.NewGuid().ToString("N"), workspacePath);
        await SendRequestAsync(request, cancellationToken);
    }

    public async Task<SidecarSearchCompleted> SearchAsync(
        SidecarSearchRequest request,
        Func<SidecarSearchResultItem, ValueTask> onResult,
        CancellationToken cancellationToken = default)
    {
        EnsureStarted();

        var streamState = new SearchStreamState(onResult);
        if (!_searchStreams.TryAdd(request.RequestId, streamState))
        {
            throw new InvalidOperationException($"A search with requestId '{request.RequestId}' is already running.");
        }

        using var registration = cancellationToken.Register(() => _ = TryCancelSearchAsync(request.RequestId));

        try
        {
            await SendMessageAsync(request, cancellationToken);
            return await streamState.Completion.Task.WaitAsync(cancellationToken);
        }
        finally
        {
            _searchStreams.TryRemove(request.RequestId, out _);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_process is null)
        {
            return;
        }

        try
        {
            _process.StandardInput.Close();
        }
        catch
        {
            // Ignore shutdown races.
        }

        if (!_process.HasExited)
        {
            _process.Kill(entireProcessTree: true);
        }

        if (_stdoutLoop is not null)
        {
            await _stdoutLoop;
        }

        if (_stderrLoop is not null)
        {
            await _stderrLoop;
        }

        _process.Dispose();
        _process = null;
    }

    private async Task<SidecarEnvelope> SendRequestAsync<TRequest>(TRequest request, CancellationToken cancellationToken)
        where TRequest : notnull
    {
        var requestId = request switch
        {
            SidecarPingRequest ping => ping.RequestId,
            SidecarInitRequest init => init.RequestId,
            SidecarDisposeRequest dispose => dispose.RequestId,
            _ => throw new InvalidOperationException($"Unsupported request type '{typeof(TRequest).Name}'."),
        };

        var pending = new TaskCompletionSource<SidecarEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pendingRequests.TryAdd(requestId, pending))
        {
            throw new InvalidOperationException($"A request with requestId '{requestId}' is already pending.");
        }

        try
        {
            await SendMessageAsync(request, cancellationToken);
            return await pending.Task.WaitAsync(cancellationToken);
        }
        finally
        {
            _pendingRequests.TryRemove(requestId, out _);
        }
    }

    private async Task SendMessageAsync<TMessage>(TMessage message, CancellationToken cancellationToken)
        where TMessage : notnull
    {
        EnsureStarted();

        var json = JsonSerializer.Serialize(message, JsonOptions);
        await _process!.StandardInput.WriteLineAsync(json.AsMemory(), cancellationToken);
        await _process.StandardInput.FlushAsync();
    }

    private async Task TryCancelSearchAsync(string requestId)
    {
        if (_process is null || _process.HasExited)
        {
            return;
        }

        var message = new SidecarCancelRequest(requestId);
        var json = JsonSerializer.Serialize(message, JsonOptions);
        await _process.StandardInput.WriteLineAsync(json);
        await _process.StandardInput.FlushAsync();
    }

    private async Task ReadStdoutLoopAsync()
    {
        while (_process is not null && !_process.HasExited)
        {
            var line = await _process.StandardOutput.ReadLineAsync();
            if (line is null)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var envelope = ParseEnvelope(line);
            await DispatchEnvelopeAsync(envelope);
        }
    }

    private async Task ReadStderrLoopAsync()
    {
        while (_process is not null && !_process.HasExited)
        {
            var line = await _process.StandardError.ReadLineAsync();
            if (line is null)
            {
                break;
            }
        }
    }

    private async Task DispatchEnvelopeAsync(SidecarEnvelope envelope)
    {
        switch (envelope.Type)
        {
            case "result":
                if (_searchStreams.TryGetValue(envelope.RequestId, out var stream) && envelope.Item is JsonElement itemElement)
                {
                    var resultItem = itemElement.Deserialize<SidecarSearchResultItem>(JsonOptions)
                        ?? throw new InvalidOperationException("Sidecar returned an empty search result item.");
                    await stream.OnResult(resultItem);
                }
                break;
            case "done":
                if (_searchStreams.TryGetValue(envelope.RequestId, out var doneStream))
                {
                    doneStream.Completion.TrySetResult(new SidecarSearchCompleted(
                        envelope.Count ?? 0,
                        envelope.DurationMs));
                }

                if (_pendingRequests.TryGetValue(envelope.RequestId, out var donePending))
                {
                    donePending.TrySetResult(envelope);
                }
                break;
            case "error":
                var error = new InvalidOperationException(envelope.Message ?? "Seeky sidecar returned an unknown error.");

                if (_searchStreams.TryGetValue(envelope.RequestId, out var errorStream))
                {
                    errorStream.Completion.TrySetException(error);
                }

                if (_pendingRequests.TryGetValue(envelope.RequestId, out var errorPending))
                {
                    errorPending.TrySetException(error);
                }
                break;
            default:
                if (_pendingRequests.TryGetValue(envelope.RequestId, out var pending))
                {
                    pending.TrySetResult(envelope);
                }
                break;
        }
    }

    private static SidecarEnvelope ParseEnvelope(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;

        JsonElement? item = root.TryGetProperty("item", out var itemElement)
            ? itemElement.Clone()
            : null;

        string? message = root.TryGetProperty("message", out var messageElement)
            ? messageElement.GetString()
            : null;

        int? count = root.TryGetProperty("count", out var countElement)
            ? countElement.GetInt32()
            : null;

        double? durationMs = root.TryGetProperty("durationMs", out var durationElement)
            ? durationElement.GetDouble()
            : null;

        return new SidecarEnvelope(
            root.GetProperty("type").GetString() ?? throw new InvalidOperationException("Sidecar envelope is missing type."),
            root.GetProperty("requestId").GetString() ?? throw new InvalidOperationException("Sidecar envelope is missing requestId."),
            item,
            message,
            count,
            durationMs);
    }

    private void EnsureStarted()
    {
        if (_process is null)
        {
            throw new InvalidOperationException("StartAsync must be called before using the Seeky sidecar.");
        }
    }

    private sealed class SearchStreamState
    {
        public SearchStreamState(Func<SidecarSearchResultItem, ValueTask> onResult)
        {
            OnResult = onResult;
        }

        public Func<SidecarSearchResultItem, ValueTask> OnResult { get; }

        public TaskCompletionSource<SidecarSearchCompleted> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
