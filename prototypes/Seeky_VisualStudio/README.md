# Seeky Visual Studio extension prototype

This is the **runnable VisualStudio.Extensibility prototype** for Seeky.

## What it does today

- adds a **Tools > Open Seeky Search** command
- adds a **Tools > Open Seeky Dialog** command
- opens a simple **floating tool window**
- opens a simple **dialog-style popup**
- uses **`Seeky.FffNative`** to call the native `fff-c` library directly
- supports the first two modes only:
  - `files`
  - `grep`

For this first pass, the tool window **tries to infer the workspace path** from the loaded project paths. You can still override it manually.

## Project layout

```text
prototypes/Seeky_VisualStudio/
  Seeky_VisualStudio.slnx
  VSSeeky/                VisualStudio.Extensibility project
```

`VSSeeky` references `..\visual-studio-2026\host\Seeky.FffNative\Seeky.FffNative.csproj` and copies the Windows `fff_c.dll` from `node_modules`.

## How to try it

1. Open `prototypes\Seeky_VisualStudio\Seeky_VisualStudio.slnx` in Visual Studio 2026.
2. Set `VSSeeky` as the startup project if it is not already selected.
3. Press `F5` to launch the experimental instance.
4. In the experimental instance, open **Tools > Open Seeky Search** or **Tools > Open Seeky Dialog**.
5. Check the auto-filled workspace path, choose `files` or `grep`, enter a query, and run the search.
6. Click a result to open the file. Grep results also navigate to their line and column.

## Current limitations

- workspace detection is based on loaded project paths, not yet on every Visual Studio "Open Folder" scenario
- no webview-based Seeky UI yet
- no `recent`, `buffers`, or symbol search yet
- result interaction is click-to-open for now; richer picker keyboard flow still needs to be added
