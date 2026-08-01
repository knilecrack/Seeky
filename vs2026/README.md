# SeekyVS — Visual Studio 2026 port spike

Spike port of the [Seeky](../README.md) VS Code extension to Visual Studio 2026, built with the
**VisualStudio.Extensibility (out-of-proc) SDK**.

**Status: VERIFIED WORKING on VS 2026 (Insiders), experimental instance.** The extension loads,
the command opens a Win32+WebView2 modal, and two-way messaging between the page and the managed
host is proven end-to-end. Since then the dummy echo was replaced with the real stack: **native
fff-c FFI search backend (incl. fuzzy grep + frecency) + Telescope-style UI** (find files / live
grep, preview pane, open-in-VS at the match line). The new stack builds clean; its F5
verification is pending — see "How to run".

## Architecture (chosen path)

**Own-process raw Win32 window + WebView2 Core (no WPF/WinForms).** The VisualStudio.Extensibility
extension runs in its own .NET process (`ServiceHub.Host.Extensibility.x64`), but that host runs
on plain `Microsoft.NETCore.App` — WPF and WinForms cannot load there (see "Why not WPF" below).
`Microsoft.Web.WebView2.Core` has no such dependency:
`CoreWebView2Environment.CreateCoreWebView2ControllerAsync(IntPtr hwnd)` hosts the browser on any
HWND. So `SeekyModalWindowManager`:

- Runs a dedicated STA thread with a **classic Win32 message loop**
  (`GetMessage`/`TranslateMessage`/`DispatchMessage` P/Invoke) plus a `ConcurrentQueue<Action>`
  work queue drained on `WM_APP`; `ShowAsync` enqueues work and wakes the loop with
  `PostThreadMessage`. A minimal `SynchronizationContext` on that thread posts continuations to
  the queue, so WebView2's async APIs resume on the UI thread (never `.Result`-block them — that
  deadlocks a single-threaded message loop).
- Creates the window with `RegisterClassEx` + `CreateWindowEx` (`WS_POPUP | WS_VISIBLE`,
  `WS_EX_TOPMOST`, ~860x520, dark class background brush), centered over the devenv main window
  (foreground-window devenv preferred, then first devenv, then primary-screen center), passing
  the devenv HWND as owner. No chrome — WebView2 covers the whole client area.
- Then: `CoreWebView2Environment.CreateAsync(userDataFolder: %LOCALAPPDATA%\SeekyVS\UserData)` →
  `CreateCoreWebView2ControllerAsync(hwnd)` → `controller.Bounds` = client rect (updated on
  `WM_SIZE`), `IsVisible = true` → `SetVirtualHostNameToFolderMapping("seeky.vs", <deployed WebUI
  folder>, Allow)` → `WebMessageReceived` dispatch (`search` → native fff via `FffNativeClient`;
  `preview` → capped file read; `open` → open the document in VS at the match line, then destroy
  the window; `close` → destroy the window) → navigate to `https://seeky.vs/index.html`.
- Lifecycle: singleton HWND; `WM_DESTROY` closes/disposes the controller and clears state so the
  command recreates the window next time; the message loop runs for the extension lifetime. Every
  step is logged (`SeekyLog`); any exception is logged with full stack **and** shown in a topmost
  Win32 `MessageBox` — failures are never silent.

The "Seeky: Open Search" command (Tools menu) triggers all this and otherwise just activates the
already-open window.

### Why not WPF in the extension host (ruled out — test result)

The previous attempt created a WPF `Window` on an own-process STA thread. The instrumented F5
test showed: the extension loads fine in host process `ServiceHub.Host.Extensibility.x64`, the
command fires, the STA UI thread starts — then `new SeekyModalWindow()` throws
`System.IO.FileNotFoundException: Could not load file or assembly 'System.Windows.Extensions,
Version=8.0.0.0'` from inside `PresentationFramework` (`SystemResources.LoadThemedDictionary`).
The out-of-proc extension host runs on plain `Microsoft.NETCore.App` and cannot resolve the full
WindowsDesktop shared framework — **WPF (and WinForms) are unusable in this host**. (The WPF
fallback error window died the same way, which is why nothing was visible.) Shipping framework
assemblies or editing runtimeconfig was considered and rejected as whack-a-mole; the Win32-HWND
route above needs no desktop framework at all.

### Why not Remote UI (ruled out — test results)

The first spike attempt used a VisualStudio.Extensibility **ToolWindow** with Remote UI XAML
embedding `<wv2:WebView2>`. Tested on a real VS 2026 machine:

1. XAML with `wv2:WebView2` **and** `wv2core:CoreWebView2CreationProperties` failed with
   `XamlParseException: Cannot create unknown type '{clr-namespace:Microsoft.Web.WebView2.Core;assembly=Microsoft.Web.WebView2.Core}CoreWebView2CreationProperties'`
   — the VS-process XAML parser cannot resolve the WebView2 **Core** assembly.
2. Removing CreationProperties (bare `<wv2:WebView2 Source="…">`): **no exception — the XAML
   parsed and the tool window opened, but the WebView2 content was blank**. Diagnosis: the WPF
   assembly resolves, but the control cannot initialize because its default user-data folder
   would be created next to `devenv.exe` (not writable), and from an out-of-proc extension there
   is no way to configure the WebView2 environment inside the VS process.

Conclusion: **Remote UI + WebView2 is a dead end for Seeky.** The tool window classes
(`SeekyToolWindow`, `SeekyToolWindowContent`, `SeekyToolWindowCommand`'s old body) are kept in
the codebase as documentation of the experiment; the command no longer opens the tool window.

## Pitfalls found (and fixes)

Everything below was hit on real hardware while getting WebView2 to work inside a
VisualStudio.Extensibility out-of-proc extension. Written up for anyone else attempting the
same — these failures are all silent or cryptic without instrumentation.

**Dead ends (architectural):**

1. **Remote UI XAML cannot host a usable WebView2.** Tool-window content is parsed and
   instantiated *inside devenv.exe*. Referencing `Microsoft.Web.WebView2.Core` types (e.g.
   `CoreWebView2CreationProperties`) fails with
   `XamlParseException: Cannot create unknown type '{clr-namespace:Microsoft.Web.WebView2.Core;assembly=Microsoft.Web.WebView2.Core}…'`
   — only `Microsoft.Web.WebView2.Wpf` resolves there. With a bare `<wv2:WebView2 Source="…">`
   the XAML parses and the tool window opens, but the control stays **blank**: it cannot
   initialize because its default user-data folder would be created next to `devenv.exe` (not
   writable), and an out-of-proc extension has no way to configure the WebView2 environment in
   the VS process.
2. **WPF (and WinForms) cannot load in the out-of-proc extension host.** The extension runs in
   `ServiceHub.Host.Extensibility.x64` on plain `Microsoft.NETCore.App`. The first WPF type
   throws `System.IO.FileNotFoundException: Could not load file or assembly
   'System.Windows.Extensions, Version=8.0.0.0'` from inside `PresentationFramework`
   (`SystemResources.LoadThemedDictionary`) — the WindowsDesktop shared framework is not
   resolvable there. Don't fight this by shipping framework assemblies or editing runtimeconfig;
   host WebView2 Core directly on a raw HWND instead (that's what this spike does).

**Bugs in the Win32 implementation (all fixed in code):**

3. **`RegisterClassEx` needs `CharSet.Unicode` in the DllImport.** The `WNDCLASSEX` struct was
   marshaled Unicode (`StructLayout(CharSet = CharSet.Unicode)`) but the `RegisterClassEx` import
   lacked the charset, so the class registered under a garbage name and `CreateWindowEx` failed
   with win32 error **1407 (ERROR_CANNOT_FIND_WND_CLASS)**. Symptom: message box "CreateWindowEx
   failed" right after a successful-looking register step.
4. **`WebView2Loader.dll` is not probed from the extension's `runtimes/` layout.** The
   NuGet-copied `runtimes/win-<arch>/native/WebView2Loader.dll` layout works for normal apps, but
   the ServiceHub extension host doesn't probe it → `DllNotFoundException: WebView2Loader`.
   Fix: `NativeLibrary.SetDllImportResolver` on the `Microsoft.Web.WebView2.Core` assembly,
   resolving the loader to the absolute path inside the deployed extension dir (under
   `%LOCALAPPDATA%\Microsoft\VisualStudio\18.0_*Exp\VSExtensions\knilecrack\Seeky\<version>\`).
5. **`AppContext.BaseDirectory` is NOT the extension folder.** In the ServiceHub host it points at
   Microsoft's host directory, so building the WebUI path from it made
   `SetVirtualHostNameToFolderMapping` throw `DirectoryNotFoundException`. Fix: anchor all
   extension-relative paths at `typeof(...).Assembly.Location`. Related cleanup: the WebView2
   user-data folder is now `%LOCALAPPDATA%\SeekyVS\UserData` — the runtime creates its `EBWebView`
   data dir inside whatever UDF it gets, and it was polluting the folder next to the log file.

## What was built and verified

- `SeekyVS.slnx` + `SeekyVS/SeekyVS.csproj` — `net10.0-windows10.0.19041.0` (C# 14; VS 2026
  ships net10 extension hosts), **no `UseWPF`** (deliberate — see "Why not WPF"),
  `AllowUnsafeBlocks` for `LibraryImport`, referencing
  `Microsoft.VisualStudio.Extensibility.Sdk` **17.14.40608** (+ matching `.Build`) and
  `Microsoft.Web.WebView2` **1.0.4078.44** (only the Core assembly is used; the Wpf/WinForms
  DLLs ship inertly in the VSIX and are never loaded).
- `SeekyVSExtension.cs` — extension entrypoint; metadata id `SeekyVS.3f6b2d8a-…`, display name "Seeky".
- `SeekyToolWindowCommand.cs` — "Seeky: Open Search" (Tools menu) →
  `SeekyModalWindowManager.ShowAsync(Extensibility, context)`.
- `SeekyModalWindowManager.cs` — the whole modal window: dedicated STA thread with a Win32 message
  loop + work queue + minimal `SynchronizationContext`; `RegisterClassEx`/`CreateWindowEx` window;
  WebView2 Core controller on the HWND (env, bounds on `WM_SIZE`, virtual host mapping anchored at
  the extension assembly location, `NativeLibrary.SetDllImportResolver` for `WebView2Loader.dll`,
  two-way messaging); devenv owner/centering; `MessageBox` error surfacing. Also the webview
  message dispatch: `search` → native fff query (stale results discarded via a generation
  counter), `preview` → capped file read, `open` → `fff_track_query` (frecency) +
  `OpenTextDocumentAsync` with caret on the match line (0-based
  `RpcContracts.Utilities.Range`), workspace resolution via
  `Workspaces().QuerySolutionAsync` with active-document fallback.
- `FffNativeClient.cs` — the search backend over the native fff C FFI (`Tools/fff_c.dll`):
  `LibraryImport` P/Invoke against `fff.h`, accessor-based result reads, strict
  free-exactly-once discipline for `FffResult` envelopes and payloads, one instance per
  workspace (`fff_restart_index` on change), `fff_wait_for_scan` with progress status,
  frecency LMDB under `<workspace>/.vs/seeky/`, `fff_track_query` on open. Replaces the deleted
  `FffMcpClient.cs` (MCP stdio sidecar).
- `Tools/fff_c.dll` — the native fff search library (sha256-verified, shipped in the VSIX as
  content next to the extension assembly).
- `SeekyLog.cs` — thread-safe file logger (`%LOCALAPPDATA%\SeekyVS\seekyvs.log`); every step of
  the extension/command/window/WebView2/fff path is logged, plus `AppDomain.UnhandledException`
  and `TaskScheduler.UnobservedTaskException`. See "Troubleshooting / diagnostics" below.
- `SeekyToolWindow.cs` / `SeekyToolWindowContent.cs` / `.xaml` — **dead-end Remote UI experiment,
  kept for documentation only** (see above).
- `WebUI/index.html` — **Telescope-style search UI** (plain JS/CSS, no build step): prompt row
  (`Find Files> ` / `Live Grep (fuzzy)> `) at top, results left + preview pane right (~50/50),
  status line at bottom. Keys: **Tab** or **Ctrl+G** toggles files/grep, **Ctrl+R** cycles grep
  sub-mode plain → regex → **fuzzy** (default — fff's signature mode), **↑/↓** (and **Ctrl+J/K**)
  move, **Enter** opens at the match line, **Esc** closes; search is debounced 150ms; selection
  drives the preview. All workspace text enters the DOM via `textContent` only (never
  `innerHTML`) — same hard rule as the VS Code Seeky. Keeps the `acquireVsCodeApi()` shim comment
  for the future `media/main.js` reuse.
- `global.json` pins .NET SDK 10.0.302 (stable; preview SDKs are installed on this machine).

**Verified:** `dotnet build` from `vs2026/` succeeds with **0 warnings, 0 errors**, producing
`SeekyVS.vsix`. The VSIX was inspected: it contains `WebUI/index.html` and all WebView2 assemblies
(`Microsoft.Web.WebView2.{Core,Wpf,WinForms}.dll` + native `WebView2Loader.dll` for
x64/arm64/x86). The `extension.vsixmanifest` targets `[17.14,)` — per
[Microsoft's VS 2026 compatibility announcement](https://devblogs.microsoft.com/visualstudio/modernizing-visual-studio-extension-compatibility-effortless-migration-for-extension-developers-and-users/),
"Visual Studio 2026 supports API version 17.x, and we determine API compatibility using only the
lower bound", so this package targets VS 2026 without an 18.x SDK.

**Verified working on real hardware (VS 2026 Insiders, experimental instance):** the full healthy
log sequence was observed — extension loads in `ServiceHub.Host.Extensibility.x64` → command → UI
thread → window created → WebView2 loader resolver → environment → controller → WebUI mapped →
navigated → `WebMessageReceived: search` per keystroke → dummy results rendered in the page →
`close` on double-Esc → `WM_DESTROY` cleanup. **Two-way messaging is proven.** Getting there took
three bug fixes — see "Pitfalls found (and fixes)". The fff-c backend + Telescope UI added
after that run builds clean but is **pending its own F5 verification** — see "How to run".

## Backend: native fff-c FFI (current)

The search backend is the **native fff C FFI library** (`Tools/fff_c.dll`, from
[dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff) release v0.10.1, asset
`c-lib-x86_64-pc-windows-msvc.dll`, sha256-verified — the same Rust engine that powers the VS
Code Seeky via `@ff-labs/fff-node`). It replaced the earlier fff-mcp stdio sidecar (MCP server,
deleted — its probe scripts `vs2026/probe-fff-mcp*.mjs` remain as historical dev tools). Going
native removes the child process, the JSON-RPC layer, and the text-result parsing, and unlocks
fff's signature **fuzzy grep** mode plus frecency learning. `FffNativeClient` implements it:

- **Interop**: C# `LibraryImport` source-generated P/Invoke (UTF-8 string marshaling) against
  [`fff.h`](https://raw.githubusercontent.com/dmtrKovalenko/fff/main/crates/fff-c/include/fff.h).
  Every function returns a heap `FffResult*` envelope — freed with `fff_free_result`; the
  payload (`handle`) is freed separately per type (`fff_free_search_result`,
  `fff_free_grep_result`, `fff_free_scan_progress`, `fff_destroy`). All fields are pulled
  through the accessor functions (no struct marshaling except the tiny blittable
  `FffCreateOptions`/`FffScanProgress`). All native calls are serialized through one lock.
- **Loading**: the extension host doesn't probe the extension folder, so
  `NativeLibrary.SetDllImportResolver` resolves `fff_c.dll` from the deployed extension dir
  (same pattern as the WebView2Loader resolver — see "Pitfalls").
- **Lifecycle**: `fff_create_instance_with` (versioned `FffCreateOptions`, `watch=true`,
  content indexing on, engine log at `%LOCALAPPDATA%\SeekyVS\fff.log`) once per workspace;
  workspace changes call `fff_restart_index`; `fff_destroy` on extension unload. Initial scan
  via `fff_wait_for_scan` (with `fff_get_scan_progress` progress into the status line), replacing
  the MCP warmup polling.
- **Frecency**: LMDB paths at `<workspace>/.vs/seeky/{frecency.db,history.db}`; `fff_track_query`
  is called on every open (frecency learning improves file ranking over time).
- **Search**: `fff_search` for fuzzy files; `fff_live_grep` for content with native modes
  **0 = plain (true literal SIMD), 1 = regex, 2 = fuzzy** — the query is passed raw; fff parses
  `*.cs pattern`-style constraints itself. (The MCP build needed manual regex-escaping for plain
  mode; native mode 0 made that code unnecessary and it was deleted.)
- **Workspace resolution** (unchanged): open solution's directory via
  `Workspaces().QuerySolutionAsync`, 'Open Folder' root, active document's directory; with
  neither, the UI shows "no workspace open".

### Message contract (page ↔ host)

Page → host:

```json
{ "type": "search",  "query": "foo", "mode": "grep", "grepMode": "fuzzy" }
                                                    // mode: "files" | "grep"
                                                    // grepMode: "plain" | "regex" | "fuzzy"
{ "type": "preview", "path": "src/a.cs", "line": 42 }          // line optional
{ "type": "open",    "path": "src/a.cs", "line": 42 }          // line optional
{ "type": "close" }
```

Host → page:

```json
{ "type": "results", "items": [ { "name": "…", "path": "src/a.cs", "line": 42, "col": 7,
                                  "text": "…", "frecency": 3 } ],
  "done": true, "capped": false, "duration": 12 }
                                                    // files mode: name=path, frecency only;
                                                    // grep mode: +line/col/text
{ "type": "preview", "path": "src/a.cs", "content": "…file text (capped 200KB/2000 lines)…",
  "line": 42 }                                      // line optional (null for files mode)
{ "type": "status",  "message": "indexing…" }       // status-line text: indexing, errors, etc.
{ "type": "setQuery", "query": "…" }                // honored by the page; not currently sent
{ "type": "setMode",  "mode": "files" }             // sent on show (Find Files / Live Grep commands)
```

Stale search responses are discarded with a generation counter (new keystroke wins).

## Open questions

Resolved by testing/research: WebView2 assembly resolution in the VS process (WPF resolves, Core
doesn't — and the route is dead anyway), WPF user-control hosting in tool windows (doesn't exist
in the SDK), WPF in the out-of-proc extension host (dead — WindowsDesktop framework unavailable),
raw Win32 window + WebView2 Core in the extension host (**works**), devenv owner selection and
keyboard focus (both work in the verified run: the popup centers on the experimental instance and
typing reaches the page immediately).

Remaining:

1. **Theme bridging.** The page is hardcoded dark (`#1e1e2e`); matching VS's actual theme needs
   the theme color APIs (`IThemingService`/`EnvironmentColors` equivalents in the out-of-proc SDK)
   pushed into the page as CSS variables — mirrors what `media/style.css` does with VS Code theme
   variables.
2. **Chromeless UX details.** No drag move (would need `WM_NCHITTEST` handling), no resize, no
   border. The window inherits the host process's DPI awareness (likely system-aware); per-monitor
   V2 would need a manifest we don't control or `SetProcessDpiAwarenessContext` — untested on
   multi-DPI setups.
3. **Focus corner cases.** The verified run had focus land correctly, but `SetForegroundWindow`
   from a non-foreground process is restricted by Windows — re-show/activation when VS was not
   foreground may still flash instead of focusing. Watch for it in real use.
4. **VS 2026 runtime for extensions.** The project targets `net10.0-windows10.0.19041.0` (VS 2026
   ships net10 extension hosts; previously net8.0, which the host also loaded fine). No action
   needed unless a future VS changes the host runtime lineup.

## How to build

```bash
cd vs2026
dotnet build          # restore + build; emits SeekyVS/bin/Debug/net10.0-windows10.0.19041.0/SeekyVS.vsix
dotnet build -c Release
```

Requires only a .NET SDK (8+; repo pins 10.0.302 via `global.json`). No Visual Studio needed.

## How to run (confirmed working on VS 2026 Insiders)

1. Install **Visual Studio 2026** (any edition; VS 2022 17.14+ should also work per the manifest).
   The WebView2 Runtime is already present on any machine with VS.
2. Open `vs2026/SeekyVS.slnx`, set `SeekyVS` as startup project, press **F5** — VS deploys the
   extension to the experimental instance and attaches the debugger.
3. In the experimental instance: **Tools → Seeky: Open Search**.

If nothing appears at all, check `%LOCALAPPDATA%\SeekyVS\seekyvs.log` against the healthy sequence
in "Troubleshooting / diagnostics" below — it pinpoints the failing step. (The WebView2 runtime
data lives in `%LOCALAPPDATA%\SeekyVS\UserData`; delete the whole `SeekyVS` folder for a clean
slate.)

Expected result — a floating, borderless, dark 860x520 popup appears, centered over (and owned by)
the VS main window, showing the Telescope-style search UI (`https://seeky.vs/index.html`):

- Prompt row at top reads **"Find Files> "** with a query box; the status line at the bottom
  shows "type to search — Tab toggles Find Files / Live Grep, Ctrl+R cycles plain → regex →
  fuzzy", then "indexing… N files" while fff scans, then "index ready — N files".
- **Find files:** type — after ~150ms debounce the results list (left) fills with
  workspace-relative paths from fff; the first result is selected and its file content shows
  in the preview pane (right).
- **Live Grep:** press **Tab** (or Ctrl+G) — the prompt label switches to "Live Grep (fuzzy)> ";
  typing shows `path:line: matched text` rows; the preview highlights the match line and scrolls
  to it. **Ctrl+R** cycles the sub-mode: plain (literal) → regex → fuzzy (default). Fuzzy demo:
  searching `shwcr` should match `ShowCoreAsync`-style identifiers that plain/regex would miss.
- **Navigation:** ↑/↓ or Ctrl+J/K moves the selection (preview follows); **Enter** opens the file
  in VS at the match line and closes the popup; **Esc** closes the popup (single Esc now).
- Re-running the command reopens the window; running it while open just activates/focuses it.
- The extension host stays alive across window close/reopen; debugging continues in VS.

If anything fails, a topmost Win32 **MessageBox** with the full exception stack pops up — that
text (plus the log) is the diagnostic to report.

## Troubleshooting / diagnostics

Every step of the extension is logged to **`%LOCALAPPDATA%\SeekyVS\seekyvs.log`** (one timestamped
line per step, with thread id; never throws). If "nothing is displayed", this log says exactly
where it died. Note the log is written by the *extension host* process, not devenv.

Healthy log sequence for one successful open (F5, then Tools → Seeky: Open Search). The
window/WebView2 half of this sequence was confirmed on VS 2026 Insiders; the fff lines are the
expected output of the new native backend (pending its F5 run):

```
SeekyVSExtension ctor — extension loaded (pid …, process 'ServiceHub.Host.Extensibility.x64')
InitializeServices
'Seeky: Open Search' command invoked                              ← command reached
Starting dedicated UI thread
UI thread message loop starting (tid …)
ShowAsync: enqueueing ShowCore on UI thread
ShowCore entered
Owner candidate: foreground devenv (pid …, title '…')             ← owner/positioning
ShowCore: positioned over devenv at (…,…)
ShowCore: window created (hwnd 0x…) at (…,…), owner 0x…
WebView2 loader path: <extension dir>\runtimes\win-x64\native\WebView2Loader.dll (exists: True)
ShowCore: WebView2 environment created
ShowCore: WebView2 controller created
WebUI dir: <extension dir>\WebUI (exists: True)
ShowCore: navigated to https://seeky.vs/index.html (mapped to '<extension dir>\WebUI')
Workspace: resolved '<solution dir>' (was '(none)')             ← fff backend
fff loader path: <extension dir>\Tools\fff_c.dll (exists: True)
fff: creating instance for '<solution dir>' (dll '<extension dir>\Tools\fff_c.dll')
fff: instance created
fff: scan complete in ~Nms (M files)                            ← fff_wait_for_scan + progress
ShowCore completed
ShowAsync completed
WebMessageReceived: search mode=files grepMode=fuzzy query='…'  ← one per debounced keystroke
Search '…' (files/plain): N results in Xms
WebMessageReceived: open '<path>' line L
fff track_query('<query>', '<path>'): ok                        ← frecency learning
WebMessageReceived: close — destroying window                   ← on Esc
WndProc: WM_DESTROY — closing WebView2 controller
Shutdown: disposing fff native client                           ← on extension unload
```

Reading the log when something is missing:

- **Log file empty/does not exist after F5** → the extension never loaded in the out-of-proc
  host. Check VS's own diagnostics: `%APPDATA%\Microsoft\VisualStudio\<version>\ActivityLog.xml`,
  and that the extension appears under Extensions → Manage Extensions in the experimental
  instance. (This would be an SDK/deployment issue, not our window code.)
- **`ctor` line present, but no `command invoked`** → the command contribution isn't wired
  (check the Tools menu actually shows "Seeky: Open Search") or the click isn't reaching the
  extension.
- **Stops between `command invoked` and `UI thread message loop starting`** → STA thread startup
  problem (look for an ERROR line with the stack).
- **Stops inside `ShowCore` before `window created`** → `RegisterClassEx`/`CreateWindowEx`
  failure; an ERROR line has the stack and a topmost MessageBox should also have appeared.
- **`window created` but stops before `navigated`** → WebView2 problem (loader DLL missing in the
  deployed extension folder, runtime blocked); ERROR line + MessageBox have the details.
- **`navigated` present but nothing visible** → check the `Owner candidate` line — if the owner
  pid/title is the *wrong* devenv (e.g. your main instance instead of the experimental one), the
  popup may be behind that window; Alt+Tab through all windows. Also check for off-screen
  coordinates in the `positioned over devenv at` line.
- **`navigated` present, window visible but page blank** → content issue: check the mapped WebUI
  path in the `navigated` line exists next to the deployed extension, and whether
  `WebMessageReceived` lines appear when typing (if yes, messaging works and it's a page issue).
- **Status line stuck on "indexing…"** → the scan never completed: look for `fff loader path:`
  (does `Tools\fff_c.dll` exist in the deployed extension dir?), `fff: creating instance`,
  `fff: instance created`, and any `fff <op> failed: …` line carrying the native error string.
  A missing dll or a create ERROR means the VSIX content item didn't deploy or the resolver
  failed. The engine's own log is at `%LOCALAPPDATA%\SeekyVS\fff.log`.
- **Status "no workspace open"** → no solution AND no active document: `Workspace: resolved
  '(none)'` in the log; open a solution or any file and re-run the command.
- **Searches return 0 results for everything** → fff indexed the wrong directory: check the
  `Workspace: resolved '…'` line — it should be your solution's directory, not the extension or
  VS install dir. (The historical `fff-mcp.exe` probe scripts `vs2026/probe-fff-mcp*.mjs` verify
  the old sidecar's behavior standalone; they don't apply to the native library.)
- **Any `AppDomain unhandled exception` / `Unobserved task exception` / `UI thread died` /
  `Work item failed` lines** → paste them; they carry full stacks.

When reporting a test run, paste the whole `seekyvs.log` (it is small) plus what you saw on
screen.

## Next steps

Done: extension shell, command, modal window, WebView2 hosting, two-way messaging — verified on
VS 2026 Insiders. Built since (pending F5 verification): native fff-c backend (LibraryImport FFI,
fuzzy files + plain/regex/fuzzy grep, frecency tracking, wait-for-scan warmup) and
Telescope-style UI (find files / live grep, preview pane, open-in-VS at the match line).
Remaining, in rough order:

1. **F5-verify the fff-c + Telescope-UI stack** (steps in "How to run"; fuzzy grep demo: `shwcr`
   should match `ShowCoreAsync`).
2. **Swap in the real Seeky UI:** copy `media/main.js`, `media/style.css`, codicons/fonts into
   the VSIX and add the `acquireVsCodeApi()` shim described in `index.html`, replacing the
   spike UI.
3. **Theme bridging** (open question 1) — push VS theme colors into the page as CSS variables.
4. **Keybinding for the command** (e.g. Ctrl+T-style chord) via the command configuration.
5. Add modes (recent/buffers/symbols/git-modified — fff exposes more primitives worth binding,
   e.g. `fff_glob`, `fff_multi_grep`, directory search).
6. Live preview via the VS editor instead of raw file reads; honor `.gitignore`-style excludes
   consistently with the VS Code Seeky.
7. Delete the dead-end Remote UI tool window classes (kept for now as documentation).
