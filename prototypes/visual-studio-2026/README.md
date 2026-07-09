# Seeky Visual Studio 2026 prototype

This folder is a spike for bringing Seeky's architecture to **Visual Studio 2026** without disturbing the existing VS Code extension.

## Why this prototype exists

Seeky already has a clean split between:

- a host shell (`src/extension.ts`)
- a search backend (`src/searchProvider.ts`)
- a web UI plus message contract (`src/webviewPanel.ts` + `media/main.js`)

Visual Studio can reuse that shape, but not the implementation details.

## Can Visual Studio use FFF?

**Yes, but not directly from C#.**

`@ff-labs/fff-node` is a Node ESM package that loads native binaries through `ffi-rs`, so the safest reuse path for a Visual Studio extension is:

1. Visual Studio host in .NET
2. WebView2 UI for the Seeky frontend
3. a small **Node sidecar** that wraps `@ff-labs/fff-node`
4. an NDJSON bridge between the host and the sidecar

That is what this prototype scaffolds.

## Scope of this spike

This first pass is intentionally limited to:

- `files`
- `grep`

The other Seeky modes are more host-specific:

- `recent` and `buffers` need Visual Studio document/window APIs
- `symbols` and `workspace-symbols` should use Roslyn rather than FFF

## Folder layout

```text
prototypes/visual-studio-2026/
  host/
    Seeky.FffNative/         .NET wrapper over the fff-c native ABI
    Seeky.VisualStudioHost/  host-side bridge and WebView bootstrapping
  sidecar/                   Node process that exposes FFF over NDJSON
```

## Key decisions baked into the prototype

### 1. Preserve the message contract

The existing webview protocol remains the seam between UI and host:

- `search`
- `results`
- `preview`
- `open`
- `close`
- `setMode`
- `setQuery`
- `focus`

The Visual Studio host should adapt to that contract instead of rewriting the frontend behavior first.

### 2. Shim VS Code's webview API in WebView2

`media/main.js` expects `acquireVsCodeApi()`. WebView2 does not provide that, so the Visual Studio host must inject a compatibility shim before loading Seeky's frontend script.

### 3. Inject startup globals explicitly

The Visual Studio host must also inject:

- `window.INITIAL_MODE`
- `window.INITIAL_QUERY`
- `window.MEDIA_URI`

Without those, Seeky's existing frontend does not initialize correctly.

### 4. Prefer the native wrapper; keep the sidecar as a fallback

`Seeky.FffNative` is the preferred path for the real Visual Studio implementation because it removes the Node runtime dependency and binds directly to the stable `fff-c` ABI.

The sidecar remains useful as:

- an early prototype path
- a comparison harness while validating the native wrapper
- a fallback if the native packaging story turns out to be harder than expected

### 5. Use streaming NDJSON, not one-shot JSON

The sidecar protocol is newline-delimited JSON so the host can:

- stream file and grep results
- cancel in-flight searches
- keep the UI responsive while typing

## Current status

The first runnable Visual Studio host now lives in:

```text
prototypes/Seeky_VisualStudio/
```

It uses **VisualStudio.Extensibility** plus the native **`Seeky.FffNative`** wrapper and proves the extension can call FFF for `files` and `grep`.

## Next step to make this real

Upgrade the simple tool window in `prototypes/Seeky_VisualStudio/` to a richer Seeky experience:

1. infer the active solution/workspace path automatically
2. decide between keeping the minimal Remote UI or moving closer to Seeky's webview-style frontend
3. add richer result interaction, preview, and open-file navigation
