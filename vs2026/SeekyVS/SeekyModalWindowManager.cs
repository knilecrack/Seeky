// SeekyVS — Visual Studio 2026 port spike for the Seeky VS Code extension.

namespace SeekyVS;

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Editor;
using Microsoft.VisualStudio.ProjectSystem.Query;
using Microsoft.VisualStudio.RpcContracts.OpenDocument;
using Microsoft.VisualStudio.Threading;
using Microsoft.Web.WebView2.Core;
using VsRange = Microsoft.VisualStudio.RpcContracts.Utilities.Range;

/// <summary>
/// Owns the Seeky modal search window: a raw Win32 window (no WPF/WinForms — the out-of-proc
/// extension host cannot load the WindowsDesktop shared framework) hosting a WebView2 via
/// <see cref="CoreWebView2Controller"/> on its HWND.
/// </summary>
/// <remarks>
/// A dedicated STA thread runs a classic message loop (<c>GetMessage</c>/<c>TranslateMessage</c>/
/// <c>DispatchMessage</c>) plus a work queue drained on <c>WM_APP</c>. A minimal
/// <see cref="SynchronizationContext"/> is installed on that thread so WebView2's async APIs
/// (<c>CreateAsync</c>, <c>CreateCoreWebView2ControllerAsync</c>) resume there — never block on
/// them with <c>.Result</c>/<c>.GetAwaiter().GetResult()</c>, that deadlocks a single-threaded
/// message loop. The loop runs for the extension lifetime; closing the window just destroys the
/// HWND and controller so the command can recreate them.
/// </remarks>
internal static class SeekyModalWindowManager
{
    private const string WindowClassName = "SeekyVSModalWindow";
    private const uint WmApp = 0x8000;
    private const uint WmDestroy = 0x0002;
    private const uint WmSize = 0x0005;
    private const uint WsPopup = 0x80000000;
    private const uint WsVisible = 0x10000000;
    private const uint WsExToolWindow = 0x00000080;
    private const int SwShow = 5;
    private const int SwHide = 0;
    private const uint MbOk = 0x0;
    private const uint MbIconError = 0x10;
    private const uint MbTopmost = 0x00040000;
    private const uint MbSetForeground = 0x00010000;
    private const int ErrorClassAlreadyExists = 1410;
    // Popup size: ~80% of the primary screen, computed at show time.
    private static int windowWidth = 1200;
    private static int windowHeight = 700;

    // Chromeless popup border: the window class background is painted in the accent color and
    // the WebView2 is inset by BorderWidth, producing a crisp frame around the page.
    private const int BorderWidth = 2;

    private static readonly ConcurrentQueue<Action> WorkQueue = new();
    private static readonly WndProcDelegate WndProcCallback = WndProc;

    private static uint uiThreadId;
    private static IntPtr hInstance;
    private static IntPtr windowHwnd;
    private static CoreWebView2Environment? environment;
    private static CoreWebView2Controller? controller;
    private static CoreWebView2? coreWebView;

    private static readonly FffNativeClient FffClient = new();
    private static VisualStudioExtensibility? extensibility;
    private static IClientContext? lastClientContext;
    private static string? workspaceDir;
    private static string requestedMode = "files";
    private static int searchGeneration;
    private static string lastSearchQuery = string.Empty;

    /// <summary>
    /// Shows the Seeky modal window, creating it on first use, or activates it if already open.
    /// </summary>
    /// <param name="extensibility">The extensibility object (for workspaces/documents APIs).</param>
    /// <param name="clientContext">The command's client context (fallback workspace source).</param>
    /// <param name="mode">Picker mode the page should start in: "files", "grep", or "git".</param>
    /// <returns>A task completing when the show request has been processed on the UI thread.</returns>
    public static Task ShowAsync(VisualStudioExtensibility extensibility, IClientContext clientContext, string mode)
    {
        SeekyModalWindowManager.extensibility = extensibility;
        lastClientContext = clientContext;
        requestedMode = mode is "files" or "grep" or "git" ? mode : "files";
        EnsureUiThread();
        SeekyLog.Info($"ShowAsync (mode={requestedMode}): enqueueing ShowCore on UI thread");
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        EnqueueWork(() => RunShowAsync(completion).Forget());
        return completion.Task;
    }

    /// <summary>
    /// Extension unload hook: destroy the fff instance.
    /// </summary>
    public static void Shutdown()
    {
        SeekyLog.Info("Shutdown: disposing fff native client");
        FffClient.Dispose();
    }

    private static async Task RunShowAsync(TaskCompletionSource completion)
    {
        try
        {
            await ShowCoreAsync();
            SeekyLog.Info("ShowCore completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("ShowCore failed", ex);
            ShowErrorMessageBox(ex);

            // Don't leave a zombie empty window behind on error.
            if (windowHwnd != IntPtr.Zero)
            {
                DestroyWindow(windowHwnd);
            }
        }
        finally
        {
            // Errors are surfaced via log + MessageBox; never fault the awaiting command.
            completion.TrySetResult();
        }
    }

    private static bool loaderResolverInstalled;

    // The extension host process does not probe the extension's runtimes/ layout for native
    // assets, so WebView2Loader.dll (shipped in the VSIX under runtimes/win-<arch>/native/)
    // is not found by the default DllImport resolution. Point the resolver at the absolute
    // path of the architecture-matching loader instead.
    private static void EnsureWebView2LoaderResolver()
    {
        if (loaderResolverInstalled)
        {
            return;
        }

        loaderResolverInstalled = true;

        string extensionDir = Path.GetDirectoryName(typeof(SeekyModalWindowManager).Assembly.Location)
            ?? AppContext.BaseDirectory;
        string arch = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win-x64",
            Architecture.X86 => "win-x86",
            Architecture.Arm64 => "win-arm64",
            _ => "win-x64",
        };
        string loaderPath = Path.Combine(extensionDir, "runtimes", arch, "native", "WebView2Loader.dll");
        SeekyLog.Info($"WebView2 loader path: {loaderPath} (exists: {File.Exists(loaderPath)})");

        NativeLibrary.SetDllImportResolver(typeof(CoreWebView2Environment).Assembly, (name, _, _) =>
        {
            if (string.Equals(name, "WebView2Loader.dll", StringComparison.OrdinalIgnoreCase)
                && File.Exists(loaderPath))
            {
                return NativeLibrary.Load(loaderPath);
            }

            return IntPtr.Zero;
        });
    }

    private static async Task ShowCoreAsync()
    {
        SeekyLog.Info("ShowCore entered");
        EnsureWebView2LoaderResolver();
        if (windowHwnd != IntPtr.Zero)
        {
            // The window is kept alive (hidden) between popups so WebView2 stays loaded —
            // re-showing is instant. Reposition over the current foreground VS instance and
            // reset the page to a clean, empty state.
            SeekyLog.Info("ShowCore: window already exists (hidden); re-showing");
            IntPtr currentOwner = FindVisualStudioMainWindow();
            windowWidth = GetSystemMetrics(0) * 8 / 10;
            windowHeight = GetSystemMetrics(1) * 8 / 10;
            GetWindowPosition(currentOwner, out int rx, out int ry);
            MoveWindow(windowHwnd, rx, ry, windowWidth, windowHeight, true);
            ShowWindow(windowHwnd, SwShow);

            // The user may have opened a different solution/folder since the last popup.
            RefreshWorkspaceAsync().Forget();
            PostJson(new { type = "reset" });
            PostJson(new { type = "setMode", mode = requestedMode });
            PostJson(new { type = "setFont", fontFamily = ResolveFontFamily() });
            FocusPopup();
            return;
        }

        IntPtr owner = FindVisualStudioMainWindow();

        // ~80% of the primary screen (SM_CXSCREEN/SM_CYSCREEN).
        windowWidth = GetSystemMetrics(0) * 8 / 10;
        windowHeight = GetSystemMetrics(1) * 8 / 10;

        GetWindowPosition(owner, out int x, out int y);

        IntPtr hwnd = CreateWindowEx(
            // Owned by devenv (below) the popup stays above VS without floating over other apps.
            // WS_EX_TOOLWINDOW keeps it out of the taskbar/Alt+Tab.
            WsExToolWindow,
            WindowClassName,
            "Seeky",
            WsPopup | WsVisible,
            x,
            y,
            windowWidth,
            windowHeight,
            owner,
            IntPtr.Zero,
            hInstance,
            IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowEx failed");
        }

        windowHwnd = hwnd;
        SeekyLog.Info($"ShowCore: window created (hwnd 0x{hwnd.ToInt64():X}) at ({x},{y}), owner 0x{owner.ToInt64():X}");

        // Own process, so the user-data folder is ours to choose (never next to devenv.exe).
        // Keep it in a subfolder so the runtime's EBWebView data doesn't mix with our log.
        string userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SeekyVS",
            "UserData");
        environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        SeekyLog.Info("ShowCore: WebView2 environment created");

        controller = await environment.CreateCoreWebView2ControllerAsync(hwnd);
        SeekyLog.Info("ShowCore: WebView2 controller created");
        if (GetClientRect(hwnd, out RECT clientRect))
        {
            controller.Bounds = ToContentRectangle(clientRect);
        }

        controller.IsVisible = true;

        // Close on Escape regardless of where keyboard focus sits inside the page — the page's
        // own Esc handler only fires when the query input is focused.
        controller.AcceleratorKeyPressed += (_, args) =>
        {
            const uint vkEscape = 0x1B;
            if (args.VirtualKey == vkEscape)
            {
                SeekyLog.Info("AcceleratorKeyPressed: Escape — hiding window");
                HidePopup();
            }
        };

        coreWebView = controller.CoreWebView2;

        // Serve the deployed WebUI folder over a virtual https origin (avoids file:// quirks).
        // Anchor at the extension assembly location — AppContext.BaseDirectory points at the
        // ServiceHub host's directory, not ours.
        string extensionDir = Path.GetDirectoryName(typeof(SeekyModalWindowManager).Assembly.Location)
            ?? AppContext.BaseDirectory;
        string webUiDir = Path.Combine(extensionDir, "WebUI");
        SeekyLog.Info($"WebUI dir: {webUiDir} (exists: {Directory.Exists(webUiDir)})");
        coreWebView.SetVirtualHostNameToFolderMapping(
            "seeky.vs", webUiDir, CoreWebView2HostResourceAccessKind.Allow);
        coreWebView.WebMessageReceived += OnWebMessageReceived;

        // Post the requested picker mode once the page's script has run (its message listener
        // is registered during parse, before DOMContentLoaded) — posting earlier could be lost.
        coreWebView.DOMContentLoaded += (_, _) =>
        {
            SeekyLog.Info($"DOMContentLoaded: posting setMode '{requestedMode}'");
            PostJson(new { type = "setMode", mode = requestedMode });
            PostJson(new { type = "setFont", fontFamily = ResolveFontFamily() });
        };
        coreWebView.Navigate("https://seeky.vs/index.html");
        SeekyLog.Info($"ShowCore: navigated to https://seeky.vs/index.html (mapped to '{webUiDir}')");

        // Kick off the search backend in the background; status is posted to the page.
        RefreshWorkspaceAsync().Forget();

        // Grab keyboard focus so the user can type immediately (VS has focus when the command runs).
        FocusPopup();
    }

    // Hiding (instead of destroying) keeps WebView2 and the page loaded — the next popup is
    // instant. The window is only destroyed on real WM_DESTROY (process shutdown).
    private static void HidePopup()
    {
        if (windowHwnd != IntPtr.Zero)
        {
            SeekyLog.Info("HidePopup: hiding window");
            ShowWindow(windowHwnd, SwHide);
        }
    }

    // SetForegroundWindow from a non-foreground process is normally rejected; attaching our input
    // queue to the current foreground thread is the standard workaround.
    private static void FocusPopup()
    {
        if (windowHwnd == IntPtr.Zero)
        {
            return;
        }

        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = foreground != IntPtr.Zero
            ? GetWindowThreadProcessId(foreground, out _)
            : 0;
        uint ourThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != ourThread
            && AttachThreadInput(ourThread, foregroundThread, true);
        try
        {
            BringWindowToTop(windowHwnd);
            SetForegroundWindow(windowHwnd);
            SetActiveWindow(windowHwnd);
            SetFocus(windowHwnd);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(ourThread, foregroundThread, false);
            }
        }

        // Move keyboard focus into the page (the query input has autofocus).
        controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
        SeekyLog.Info($"FocusPopup: foreground was 0x{foreground.ToInt64():X}, attached={attached}");
    }

    private static void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
            if (!doc.RootElement.TryGetProperty("type", out JsonElement typeElement))
            {
                return;
            }

            switch (typeElement.GetString())
            {
                case "search":
                    {
                        string query = GetString(doc.RootElement, "query") ?? string.Empty;
                        string mode = GetString(doc.RootElement, "mode") ?? "files";
                        string grepMode = GetString(doc.RootElement, "grepMode") ?? "plain";
                        SeekyLog.Info($"WebMessageReceived: search mode={mode} grepMode={grepMode} query='{query}'");
                        HandleSearchAsync(query, mode, grepMode).Forget();
                        break;
                    }

                case "preview":
                    {
                        string? path = GetString(doc.RootElement, "path");
                        int? line = GetInt(doc.RootElement, "line");
                        bool isBinary = GetBool(doc.RootElement, "binary");
                        if (path is not null)
                        {
                            HandlePreviewAsync(path, line, isBinary).Forget();
                        }

                        break;
                    }

                case "open":
                    {
                        string? path = GetString(doc.RootElement, "path");
                        int? line = GetInt(doc.RootElement, "line");
                        SeekyLog.Info($"WebMessageReceived: open '{path}' line {line}");

                        // Close the popup immediately (telescope behavior). The VS document-open
                        // call hangs when awaited on this UI thread, so it runs on the threadpool
                        // in the background — it must never block window teardown.
                        HidePopup();
                        Task.Run(() => HandleOpenAsync(path, line)).Forget();
                        break;
                    }

                case "close":
                    SeekyLog.Info("WebMessageReceived: close — hiding window");
                    HidePopup();
                    break;
                default:
                    SeekyLog.Info($"WebMessageReceived: unhandled type '{typeElement.GetString()}'");
                    break;
            }
        }
        catch (JsonException)
        {
            // Ignore malformed messages from the page.
        }
    }

    // ------------------------------------------------------------------ Search / preview / open

    private static string? GetString(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? GetInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value) && value.TryGetInt32(out int number)
            ? number
            : null;

    private static bool GetBool(JsonElement element, string property) =>
        element.TryGetProperty(property, out JsonElement value)
        && value.ValueKind == JsonValueKind.True;

    private static void PostJson(object message) =>
        coreWebView?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    private static void PostStatus(string message) => PostJson(new { type = "status", message });

    private const string MonoFontStack = "'Cascadia Code', Consolas, 'Courier New', monospace";
    private const string SystemFontStack = "'Segoe UI', system-ui, sans-serif";

    /// <summary>
    /// Resolves the popup font from <c>%LOCALAPPDATA%\SeekyVS\settings.json</c>
    /// (<c>{ "fontFamily": "…" }</c>), re-read on every popup show so edits apply without
    /// restarting VS. Keywords: <c>mono</c> (default) and <c>system</c>; any other string is
    /// used verbatim as a CSS font-family value after sanitizing (it is injected into an inline
    /// style). Missing/malformed/unsafe values fall back to the mono stack.
    /// </summary>
    private static string ResolveFontFamily()
    {
        string settingsPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SeekyVS",
            "settings.json");
        try
        {
            if (!File.Exists(settingsPath))
            {
                // Seed a discoverable default once; ignore failures (dir may not exist yet).
                try
                {
                    File.WriteAllText(settingsPath, "{\n  \"fontFamily\": \"mono\"\n}\n");
                }
                catch (Exception ex)
                {
                    SeekyLog.Error("settings.json: writing the default file failed", ex);
                }

                return MonoFontStack;
            }

            using JsonDocument settings = JsonDocument.Parse(File.ReadAllText(settingsPath));
            string? fontFamily =
                settings.RootElement.TryGetProperty("fontFamily", out JsonElement element)
                && element.ValueKind == JsonValueKind.String
                    ? element.GetString()?.Trim()
                    : null;

            if (string.IsNullOrEmpty(fontFamily) || fontFamily.Equals("mono", StringComparison.OrdinalIgnoreCase))
            {
                return MonoFontStack;
            }

            if (fontFamily.Equals("system", StringComparison.OrdinalIgnoreCase))
            {
                return SystemFontStack;
            }

            // Verbatim values land in an inline style — reject anything that could break out
            // of the CSS declaration.
            if (fontFamily.Any(c => c is ';' or '{' or '}' or '<' or '>' or '"' or '\'' || char.IsControl(c)))
            {
                SeekyLog.Info($"settings.json: rejecting unsafe fontFamily value '{fontFamily}'");
                return MonoFontStack;
            }

            SeekyLog.Info($"settings.json: fontFamily '{fontFamily}'");
            return fontFamily;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            SeekyLog.Error($"settings.json: unreadable ({settingsPath})", ex);
            return MonoFontStack;
        }
    }

    /// <summary>
    /// Re-resolves the workspace directory on every popup show (the user may have opened a
    /// different solution or folder since the last one). When it changed, the fff instance
    /// restarts its index against the new root (<see cref="FffNativeClient.StartAsync"/> calls
    /// <c>fff_restart_index</c> whenever the workspace directory differs from the current one).
    /// </summary>
    private static async Task RefreshWorkspaceAsync()
    {
        try
        {
            string? resolved = await ResolveWorkspaceDirAsync(CancellationToken.None);
            SeekyLog.Info($"Workspace: resolved '{resolved ?? "(none)"}' (was '{workspaceDir ?? "(none)"}')");
            if (string.Equals(resolved, workspaceDir, StringComparison.OrdinalIgnoreCase))
            {
                // Same workspace — still refresh git status so badges/Git Modified reflect
                // changes made since the last popup (best-effort, background).
                FffClient.RefreshGitStatusAsync(CancellationToken.None).Forget();
                return;
            }

            workspaceDir = resolved;
            if (resolved is null)
            {
                SeekyLog.Info("Workspace: no workspace open");
                PostStatus("no workspace open — open a solution or a file");
                return;
            }

            SeekyLog.Info($"Workspace: changed to '{resolved}' — restarting the fff index");
            await FffClient.StartAsync(resolved, PostStatus, CancellationToken.None);
            FffClient.RefreshGitStatusAsync(CancellationToken.None).Forget();
        }
        catch (Exception ex)
        {
            SeekyLog.Error("Workspace refresh failed", ex);
            PostStatus("search backend failed to start: " + ex.Message);
        }
    }

    /// <summary>
    /// The open solution's directory; in 'Open Folder' mode (no solution open) the folder
    /// workspace root reported by the project-system query model; falls back to the active
    /// document's directory; then null.
    /// </summary>
    private static async Task<string?> ResolveWorkspaceDirAsync(CancellationToken cancellationToken)
    {
        if (extensibility is not null)
        {
            try
            {
                var solutions = await extensibility.Workspaces().QuerySolutionAsync(
                    solution => solution.With(s => new { s.Path, s.Directory }),
                    cancellationToken);
                var solution = solutions.FirstOrDefault();
                if (solution is not null)
                {
                    // 'Open Folder' mode: no .sln is loaded, so Path is empty or points at the
                    // folder itself while Directory carries the folder workspace root.
                    if (!string.IsNullOrEmpty(solution.Directory) && Directory.Exists(solution.Directory))
                    {
                        return solution.Directory;
                    }

                    if (!string.IsNullOrEmpty(solution.Path))
                    {
                        if (Directory.Exists(solution.Path))
                        {
                            return solution.Path; // the workspace root IS a folder
                        }

                        string? solutionDir = Path.GetDirectoryName(solution.Path);
                        if (!string.IsNullOrEmpty(solutionDir))
                        {
                            return solutionDir;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                SeekyLog.Error("Solution query failed; trying active document", ex);
            }

            try
            {
                if (lastClientContext is not null)
                {
                    using ITextViewSnapshot? textView =
                        await extensibility.Editor().GetActiveTextViewAsync(lastClientContext, cancellationToken);
                    Uri? documentUri = textView?.Document?.Uri;
                    if (documentUri is not null && documentUri.IsFile)
                    {
                        return Path.GetDirectoryName(documentUri.LocalPath);
                    }
                }
            }
            catch (Exception ex)
            {
                SeekyLog.Error("Active document query failed", ex);
            }
        }

        return null;
    }

    private static async Task HandleSearchAsync(string query, string mode, string grepMode)
    {
        int generation = Interlocked.Increment(ref searchGeneration);
        lastSearchQuery = query;
        var stopwatch = Stopwatch.StartNew();
        try
        {
            if (workspaceDir is null)
            {
                PostStatus("no workspace open — open a solution or a file");
                return;
            }

            // No-op when already indexed; restarts the index if the workspace changed.
            await FffClient.StartAsync(workspaceDir, PostStatus, CancellationToken.None);

            const int maxResults = 100;
            List<object> items;
            if (mode == "grep")
            {
                // Live-grep with an empty query matches everything — show nothing instead.
                if (string.IsNullOrWhiteSpace(query))
                {
                    items = new List<object>();
                }
                else
                {
                    // Native fff modes: 0 = plain SIMD (true literal), 1 = regex, 2 = fuzzy.
                    // The query goes raw — fff parses '*.cs pattern'-style constraints itself.
                    FffNativeClient.GrepMode nativeMode = grepMode switch
                    {
                        "regex" => FffNativeClient.GrepMode.Regex,
                        "fuzzy" => FffNativeClient.GrepMode.Fuzzy,
                        _ => FffNativeClient.GrepMode.Plain,
                    };
                    FffNativeClient.GrepResult result =
                        await FffClient.GrepAsync(query, nativeMode, maxResults, CancellationToken.None);
                    if (result.RegexFallbackError is not null)
                    {
                        PostStatus($"regex error (fell back to literal): {result.RegexFallbackError}");
                    }

                    items = result.Matches
                        .Select(m => (object)new
                        {
                            name = m.Text,
                            path = m.Path,
                            line = m.Line,
                            col = m.Col,
                            text = m.Text,
                            // (start, end) UTF-16 char-index pairs into 'text' for highlighting.
                            ranges = m.Ranges.Select(r => new[] { r.Start, r.End }).ToArray(),
                            gitStatus = m.GitStatus,
                            isBinary = m.IsBinary,
                            isDefinition = m.IsDefinition,
                        })
                        .ToList();
                }
            }
            else if (mode == "git")
            {
                // "Git Modified": fuzzy file search filtered to files with a git status
                // (empty query → all modified files, frecency-ranked — see FffNativeClient).
                IReadOnlyList<FffNativeClient.FileItem> files =
                    await FffClient.GitModifiedAsync(query, maxResults, CancellationToken.None);
                items = files
                    .Select(f => (object)new
                    {
                        name = f.Path,
                        path = f.Path,
                        frecency = f.FrecencyScore,
                        gitStatus = f.GitStatus,
                        isBinary = f.IsBinary,
                    })
                    .ToList();
            }
            else
            {
                IReadOnlyList<FffNativeClient.FileItem> files =
                    await FffClient.FindFilesAsync(query, maxResults, CancellationToken.None);
                items = files
                    .Select(f => (object)new
                    {
                        name = f.Path,
                        path = f.Path,
                        frecency = f.FrecencyScore,
                        gitStatus = f.GitStatus,
                        isBinary = f.IsBinary,
                    })
                    .ToList();
            }

            if (generation != searchGeneration)
            {
                SeekyLog.Info($"Search '{query}' ({mode}/{grepMode}): discarded stale results ({items.Count} items)");
                return;
            }

            SeekyLog.Info($"Search '{query}' ({mode}/{grepMode}): {items.Count} results in {stopwatch.ElapsedMilliseconds}ms");
            PostJson(new
            {
                type = "results",
                done = true,
                capped = items.Count >= maxResults,
                duration = stopwatch.ElapsedMilliseconds,
                items,
            });
        }
        catch (Exception ex)
        {
            SeekyLog.Error($"Search '{query}' ({mode}/{grepMode}) failed", ex);
            PostStatus("search failed: " + ex.Message);
        }
    }

    private static async Task HandlePreviewAsync(string path, int? line, bool isBinary)
    {
        try
        {
            if (workspaceDir is null)
            {
                return;
            }

            // Never read binary files — the page shows a neutral note instead.
            if (isBinary)
            {
                PostJson(new { type = "preview", path, binary = true });
                return;
            }

            string absolutePath = Path.Combine(workspaceDir, path);

            // Cap at ~200KB / 2000 lines — the preview is a glance, not an editor.
            const int maxBytes = 200 * 1024;
            const int maxLines = 2000;
            var buffer = new byte[maxBytes];
            int read;
            await using (var stream = new FileStream(
                absolutePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, maxBytes, FileOptions.SequentialScan))
            {
                read = await stream.ReadAsync(buffer.AsMemory(0, maxBytes));
            }

            string text = Encoding.UTF8.GetString(buffer, 0, read);
            string[] lines = text.Split('\n');
            if (lines.Length > maxLines)
            {
                text = string.Join('\n', lines.Take(maxLines));
            }

            PostJson(new { type = "preview", path, content = text, line });
        }
        catch (Exception ex)
        {
            SeekyLog.Error($"Preview of '{path}' failed", ex);
            PostStatus("preview failed: " + ex.Message);
        }
    }

    private static async Task HandleOpenAsync(string? path, int? line)
    {
        try
        {
            if (path is null || workspaceDir is null || extensibility is null)
            {
                return;
            }

            string absolutePath = Path.Combine(workspaceDir, path);
            // RpcContracts Range is 0-based; Selection places the caret on the match line.
            VsRange? selection = line is int lineNumber && lineNumber > 0
                ? new VsRange(lineNumber - 1, 0, lineNumber - 1, 0)
                : null;
            var options = new OpenDocumentOptions(
                selection: selection,
                ensureVisible: null,
                ensureVisibleOptions: null,
                isPreview: false,
                activate: true,
                logicalView: null,
                projectId: null,
                editorType: null);

            SeekyLog.Info($"Open: '{absolutePath}' line {line}");

            // Frecency learning: record the pick (best-effort; never blocks the open).
            // fff canonicalizes the path, so it must be absolute — a workspace-relative path
            // resolves against the extension host's CWD and fails with os error 3.
            FffClient.TrackQueryAsync(lastSearchQuery, absolutePath, CancellationToken.None).Forget();

            await extensibility.Documents()
                .OpenTextDocumentAsync(new Uri(absolutePath), options, CancellationToken.None)
                .WaitAsync(TimeSpan.FromSeconds(10));
            SeekyLog.Info($"Open: '{absolutePath}' completed");
        }
        catch (Exception ex)
        {
            SeekyLog.Error($"Open of '{path}' failed", ex);
            PostStatus("open failed: " + ex.Message);
        }
    }

    private static void ShowErrorMessageBox(Exception ex)
    {
        try
        {
            _ = MessageBox(
                IntPtr.Zero,
                "SeekyVS failed to show the search window. Details (also in %LOCALAPPDATA%\\SeekyVS\\seekyvs.log):\n\n" + ex,
                "SeekyVS — failed to open search window",
                MbOk | MbIconError | MbTopmost | MbSetForeground);
        }
        catch (Exception messageBoxEx)
        {
            SeekyLog.Error("MessageBox failed too", messageBoxEx);
        }
    }

    // ------------------------------------------------------------------ UI thread + message loop

    private static void EnsureUiThread()
    {
        if (uiThreadId != 0)
        {
            return;
        }

        lock (WorkQueue)
        {
            if (uiThreadId != 0)
            {
                return;
            }

            SeekyLog.Info("Starting dedicated UI thread");
            using var ready = new ManualResetEventSlim();
            var thread = new Thread(() => UiThreadMain(ready))
            {
                IsBackground = true,
                Name = "SeekyVS UI",
            };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            ready.Wait();
        }
    }

    private static void UiThreadMain(ManualResetEventSlim ready)
    {
        try
        {
            uiThreadId = GetCurrentThreadId();
            SynchronizationContext.SetSynchronizationContext(new UiThreadSynchronizationContext());
            RegisterWindowClass();

            // Force creation of the thread message queue so PostThreadMessage can't fail.
            PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
            ready.Set();
            SeekyLog.Info($"UI thread message loop starting (tid {uiThreadId})");

            while (true)
            {
                int result = GetMessage(out MSG msg, IntPtr.Zero, 0, 0);
                if (result == 0)
                {
                    break; // WM_QUIT
                }

                if (result < 0)
                {
                    SeekyLog.Info($"GetMessage failed (win32 {Marshal.GetLastWin32Error()})");
                    break;
                }

                if (msg.Hwnd == IntPtr.Zero && msg.Message == WmApp)
                {
                    DrainWorkQueue();
                    continue;
                }

                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            SeekyLog.Info("UI thread message loop exited (unexpected)");
        }
        catch (Exception ex)
        {
            SeekyLog.Error("UI thread died", ex);
            ready.Set();
        }
    }

    private static void EnqueueWork(Action work)
    {
        WorkQueue.Enqueue(work);
        if (!PostThreadMessage(uiThreadId, WmApp, UIntPtr.Zero, IntPtr.Zero))
        {
            SeekyLog.Info($"PostThreadMessage failed (win32 {Marshal.GetLastWin32Error()})");
        }
    }

    private static void DrainWorkQueue()
    {
        while (WorkQueue.TryDequeue(out Action? work))
        {
            try
            {
                work();
            }
            catch (Exception ex)
            {
                SeekyLog.Error("Work item failed on UI thread", ex);
            }
        }
    }

    /// <summary>
    /// Posts continuations onto the UI thread's work queue, so WebView2 async APIs resume there.
    /// </summary>
    private sealed class UiThreadSynchronizationContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state) => EnqueueWork(() => d(state));
    }

    // ------------------------------------------------------------------ Window procedure

    private static void RegisterWindowClass()
    {
        hInstance = GetModuleHandle(null);
        var windowClass = new WNDCLASSEX
        {
            CbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
            Style = 0,
            LpfnWndProc = Marshal.GetFunctionPointerForDelegate(WndProcCallback),
            CbClsExtra = 0,
            CbWndExtra = 0,
            HInstance = hInstance,
            HIcon = IntPtr.Zero,
            HCursor = IntPtr.Zero,
            HbrBackground = CreateSolidBrush(0x00D69C56), // COLORREF is 0x00BBGGRR — #569CD6 (VS accent blue)
            LpszMenuName = null,
            LpszClassName = WindowClassName,
            HIconSm = IntPtr.Zero,
        };
        ushort atom = RegisterClassEx(ref windowClass);
        if (atom == 0 && Marshal.GetLastWin32Error() != ErrorClassAlreadyExists)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "RegisterClassEx failed");
        }
    }

    private static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        switch (msg)
        {
            case WmSize:
                if (controller is not null && GetClientRect(hwnd, out RECT clientRect))
                {
                    controller.Bounds = ToContentRectangle(clientRect);
                }

                return IntPtr.Zero;
            case WmDestroy:
                SeekyLog.Info("WndProc: WM_DESTROY — closing WebView2 controller");
                try
                {
                    controller?.Close();
                }
                catch (Exception ex)
                {
                    SeekyLog.Error("Closing the WebView2 controller failed", ex);
                }

                controller = null;
                coreWebView = null;
                windowHwnd = IntPtr.Zero;
                break;
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    // ------------------------------------------------------------------ Positioning (devenv owner)

    private static void GetWindowPosition(IntPtr owner, out int x, out int y)
    {
        if (owner != IntPtr.Zero && GetWindowRect(owner, out RECT rect))
        {
            // Centered over the VS main window like Ctrl+T, slightly above middle.
            x = rect.Left + Math.Max(0, ((rect.Right - rect.Left) - windowWidth) / 2);
            y = rect.Top + Math.Max(0, ((rect.Bottom - rect.Top) - windowHeight) / 3);
            SeekyLog.Info($"ShowCore: positioned over devenv at ({x},{y})");
        }
        else
        {
            x = Math.Max(0, (GetSystemMetrics(0) - windowWidth) / 2);
            y = Math.Max(0, (GetSystemMetrics(1) - windowHeight) / 3);
            SeekyLog.Info("ShowCore: no devenv window found; centered on primary screen, no owner");
        }
    }

    private static IntPtr FindVisualStudioMainWindow()
    {
        // Prefer the devenv that owns the foreground window: when the user clicks the menu
        // command, the experimental instance that loaded the extension is the foreground one.
        IntPtr foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            _ = GetWindowThreadProcessId(foreground, out uint pid);
            try
            {
                using Process foregroundProcess = Process.GetProcessById((int)pid);
                if (foregroundProcess.ProcessName.Equals("devenv", StringComparison.OrdinalIgnoreCase))
                {
                    SeekyLog.Info($"Owner candidate: foreground devenv (pid {pid}, title '{foregroundProcess.MainWindowTitle}')");
                    return foreground;
                }

                SeekyLog.Info($"Foreground window is not devenv (pid {pid}, process '{foregroundProcess.ProcessName}'); falling back");
            }
            catch (Exception ex)
            {
                SeekyLog.Error("Inspecting foreground window failed; falling back", ex);
            }
        }
        else
        {
            SeekyLog.Info("No foreground window; falling back to first devenv");
        }

        Process? devenv = Process.GetProcessesByName("devenv").FirstOrDefault(p => p.MainWindowHandle != IntPtr.Zero);
        if (devenv is not null)
        {
            SeekyLog.Info($"Owner candidate: first devenv with main window (pid {devenv.Id}, title '{devenv.MainWindowTitle}')");
            return devenv.MainWindowHandle;
        }

        SeekyLog.Info("No devenv process with a main window found");
        return IntPtr.Zero;
    }

    private static Rectangle ToContentRectangle(RECT rect) =>
        new(
            rect.Left + BorderWidth,
            rect.Top + BorderWidth,
            Math.Max(0, (rect.Right - rect.Left) - (2 * BorderWidth)),
            Math.Max(0, (rect.Bottom - rect.Top) - (2 * BorderWidth)));

    // ------------------------------------------------------------------ P/Invoke

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr Hwnd;
        public uint Message;
        public UIntPtr WParam;
        public UIntPtr LParam;
        public uint Time;
        public POINT Pt;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint CbSize;
        public uint Style;
        public IntPtr LpfnWndProc;
        public int CbClsExtra;
        public int CbWndExtra;
        public IntPtr HInstance;
        public IntPtr HIcon;
        public IntPtr HCursor;
        public IntPtr HbrBackground;
        public string? LpszMenuName;
        public string LpszClassName;
        public IntPtr HIconSm;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        uint dwExStyle,
        string lpClassName,
        string lpWindowName,
        uint dwStyle,
        int x,
        int y,
        int nWidth,
        int nHeight,
        IntPtr hWndParent,
        IntPtr hMenu,
        IntPtr hInstance,
        IntPtr lpParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string lpText, string lpCaption, uint uType);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateSolidBrush(uint crColor);
}
