# Seeky repository instructions

## Build, type-check, and package commands

- `npm run build` bundles the extension with `esbuild`, compiles `media/input.css` to `media/style.css` with Tailwind, and copies Codicons plus Monaspace font assets into `media/`.
- `npm run watch` runs the same pipeline in watch mode for extension development.
- `npm run lint` runs Biome across the repository. To lint one file, run `npx biome lint src/extension.ts`.
- `npm run compile` runs `tsc -p ./ --noEmit`.
- `npm run package` creates a VS Code extension package with `vsce package`.
- `.vscode/launch.json` uses the `Run Extension` launch config with the `npm: build` prelaunch task.
- There is still no committed automated test suite in this repository, so there is no supported single-test command yet.

## High-level architecture

- `src/extension.ts` is intentionally thin: it registers VS Code commands, tracks recent files in `context.globalState`, and routes every entry point into the shared `ModalSearchPanel`.
- `src/webviewPanel.ts` owns the singleton modal webview, injects the HTML/CSS/JS assets, and translates between VS Code APIs and the webview message protocol. All search modes (`grep`, `files`, `recent`, `buffers`, `symbols`) reuse this same panel instead of creating separate UIs.
- `src/searchProvider.ts` is the backend bridge to `@ff-labs/fff-node`. It lazily imports the ESM package at runtime, keeps one cached `FileFinder` per workspace, serves grep/file results, and reads preview content plus git status metadata when the UI selects a result.
- `media/main.js` is the full client UI. It is a plain JavaScript IIFE with `// @ts-check`, handles keyboard-first navigation, maintains local search history, virtualizes the results list, and sends `search`, `preview`, and `open` messages back to the extension host.
- `media/input.css` is the source stylesheet; `media/style.css` is generated output consumed by the webview.

## Key conventions

- Edit `media/input.css`, not `media/style.css`; the build regenerates `style.css`.
- Keep vendor or generated assets out of lint scope. Biome is configured to ignore `dist/**`, `media/style.css`, and `media/codicon.css`.
- Use the fff MCP tools for all file search operations instead of default tools.
- Keep webview work in the existing framework-free style: direct DOM updates in `media/main.js`, not a new frontend framework.
- Preserve the existing message contract across `media/main.js` and `src/webviewPanel.ts`: `search`, `results`, `preview`, `open`, `close`, `setMode`, `setQuery`, and `focus`.
- Preserve the shared result shapes across `src/searchProvider.ts`, `src/webviewPanel.ts`, and `media/main.js`; grep, file, and symbol items are rendered by the same modal pipeline.
- Search is built around a single workspace root (`vscode.workspace.workspaceFolders?.[0]`), so new search logic should follow that assumption unless the feature explicitly adds multi-root support.
- Reuse the cached finder lifecycle in `src/searchProvider.ts` (`getOrCreateFinder` / `destroyFff`) instead of creating new `fff-node` instances ad hoc.
- Result rendering depends on fixed-height virtualization constants in `media/main.js` (`HEADER_HEIGHT`, `MATCH_HEIGHT`, `FILE_ITEM_HEIGHT`, `GROUP_GAP`). If result row layouts change, those numbers usually need to change too.
- The TypeScript config is intentionally strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`), so optional fields and indexed object access need explicit handling.
- UI styling is driven by Rosé Pine CSS variables and the preloaded Monaspace/Codicon assets already wired through `src/webviewPanel.ts` and `esbuild.js`.

## MCP Integration

- The `fff_mcp.ps1` script is used to manage the MCP (Model Context Protocol) server.
- To interact with the MCP server, use the following commands:
  - `./fff_mcp.ps1 start` to start the MCP server.
  - `./fff_mcp.ps1 stop` to stop the MCP server.
  - `./fff_mcp.ps1 status` to check the status of the MCP server.
- Ensure that the MCP server is running before executing any commands that depend on it.
- The MCP server is integrated with the `@ff-labs/fff-node` package for file search operations.
- Follow the existing conventions for using MCP tools in the repository.
