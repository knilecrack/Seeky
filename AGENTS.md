# AGENTS.md — Seeky

Guidance for AI coding agents working in this repository. Read this before making changes.

## Project overview

**Seeky** is a VS Code extension (publisher `knilecrack`, currently v0.2.0) that brings a
Telescope-inspired (Neovim), keyboard-driven modal search experience to VS Code: live grep,
file finder, recent files, open buffers, document/workspace symbols, and git-modified files —
all with real-time previews.

The search backend is [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node)
(the native Rust `fff` engine with Node bindings), which does fuzzy file search, grep
(plain/regex/fuzzy modes), and frecency-based ranking. Seeky does **not** shell out to
ripgrep/fzf directly. Syntax highlighting in previews uses **Shiki** with a CSS-variables theme.

> Note: `README.md` describes an older concept (ripgrep + fzf child processes, QuickPick UI)
> and is stale. This file, `GEMINI.md`, and `.github/copilot-instructions.md` reflect the
> current architecture. Prefer the code over the README when they disagree.

### Three UI hosts, one controller

The same search UI runs in three VS Code hosts, all sharing `SeekyWebviewController` and the
same HTML/JS/CSS in `src/webviewPanel.ts`:

1. **Modal** (`ModalSearchPanel`) — singleton `WebviewPanel` opened in the active editor column
   (`seeky.grep`, `seeky.findFiles`, etc.). Disposes itself after opening a result.
2. **Sidebar** (`SeekySidebarViewProvider`, view type `seeky.sidebar`) — persistent view in the
   activity-bar container; stays open after opening results. Mode/query persisted in
   `workspaceState`.
3. **Ivy panel** (`SeekyIvyViewProvider`, view type `seeky.ivy`) — same UI in the bottom panel
   container (`layout: 'ivy'`).

Additionally there are native QuickPick-based commands in `src/commands/`:

- `modalQuickPick.ts` — fuzzy file picker (`seeky.openModal`)
- `modalGrep.ts` — grouped grep picker (`seeky.openModalGrep`) with `\f` / `\p` / `\r` query prefixes
- `currentTabFuzzy.ts` — in-buffer fuzzy line search over the current buffer or all open
  buffers (`seeky.grepCurrentTab`, `seeky.fuzzyOpenBuffers`, `seeky.toggleFuzzyScope`), with
  auto-preview via the `seeky-preview:` virtual document scheme

## Tech stack

- **Extension host**: TypeScript (strict), bundled to CommonJS with **esbuild**
  (`dist/extension.js`). The `vscode` module and `@ff-labs/fff-node` are external.
- **Search engine**: `@ff-labs/fff-node` — ESM-only, loaded via dynamic `import()` inside
  `src/searchProvider.ts` (see `ESM_IMPORTS.md` for the required pattern).
- **Webview UI**: framework-free vanilla JS (`media/main.js`, an IIFE with `// @ts-check`),
  direct DOM manipulation, virtualized result list.
- **Styling**: Tailwind CSS v4 (`@tailwindcss/cli`). Source is `media/input.css`; the build
  emits `media/style.css` (generated — never edit it). Theme colors are CSS variables mapped
  to VS Code theme variables with Tokyo Night (dark) / Rosé Pine Dawn (light) fallbacks.
- **Fonts/icons**: Monaspace (Argon/Krypton/Neon/Radon/Xenon via `@fontsource`) and
  `@vscode/codicons`, copied into `media/` by the build.
- **Lint/format**: Biome v2 (`biome.json`).
- **Node**: 20.x (CI uses `UseNode@1` with `20.x`). VS Code engine `^1.95.0`.

## Repository layout

```
src/
  extension.ts            Entry point: registers webview view providers, all commands,
                          MRU (recent files) tracking in workspaceState, preview content provider
  webviewPanel.ts         Shared HTML template + SeekyWebviewController (message handling,
                          search dispatch, preview, open); ModalSearchPanel, Sidebar, Ivy providers
  searchProvider.ts       Backend bridge to fff-node: cached FileFinder per workspace,
                          searchGrep/searchFiles/searchGitModifiedFiles, frecency tracking,
                          Shiki-highlighted file previews, git diff previews
  types.ts                Shared enums/interfaces (SeekySearchOptions, QuickPick item shapes)
  logger.ts               `log` — output-channel logger ("Seeky")
  commands/               QuickPick-based pickers (modal file picker, modal grep, buffer fuzzy)
  fuzzy/                  Line-level fuzzy matcher + item builders for buffer search
  preview/                `seeky-preview:` TextDocumentContentProvider for read-only previews
  ui/                     QuickPick buttons and editor decoration helpers
media/
  main.js                 Webview client logic (keyboard nav, modes, virtualization)
  input.css               Tailwind v4 source stylesheet — EDIT THIS ONE
  style.css               Generated CSS output — DO NOT EDIT
  icon-map.js             File-icon mapping for the results list
  codicon.* / monaspace-*.woff2   Vendored assets copied from node_modules by the build
dist/                     esbuild bundle output (generated)
esbuild.js                Build script (see below)
biome.json / tsconfig.json / tailwind.config.js
azure-pipelines.yml       CI/CD (Azure DevOps)
fff_mcp.ps1               Standalone PowerShell installer for the fff-mcp binary (not part of
                          the extension runtime; excluded from the .vsix)
User/fff-mcp.exe          Local fff-mcp binary copy (excluded from the .vsix)
```

Supporting docs: `new-command-instructions.md` (step-by-step guide for adding commands),
`ESM_IMPORTS.md` (ESM-in-CJS pattern), `GEMINI.md`, `.github/copilot-instructions.md`.

## Build and development commands

| Command | What it does |
|---|---|
| `npm run build` | Full build: Tailwind CLI compiles `media/input.css` → `media/style.css` (minified), copies codicons + Monaspace fonts into `media/`, esbuild bundles `src/extension.ts` → `dist/extension.js` (CJS, minified, sourcemap) |
| `npm run watch` | Same pipeline in watch mode (unminified), spawns Tailwind `--watch` |
| `npm run compile` | Type check only: `tsc -p ./ --noEmit` |
| `npm run lint` | `biome lint .` (single file: `npx biome lint src/extension.ts`) |
| `npm run package` | Bumps patch version and runs `vsce package` to produce a `.vsix` |

There is no separate build-config file — `esbuild.js` is the build. It declares
`external: ['vscode', '@ff-labs/fff-node']`; native/ESM deps must stay external.

Run after every change (per `new-command-instructions.md`):

```bash
npm run compile
npm run lint
npm run build
```

Manual verification: press **F5** (launch config "Run Extension") to open the Extension
Development Host; the prelaunch task runs `npm: build`.

## Testing

**There is no committed automated test suite** — no test script in `package.json`, no test
directory. (`.vscode/launch.json` still contains an "Extension Tests" config pointing at a
nonexistent `out/test/suite` — do not rely on it.) Verify changes with `compile` + `lint` +
`build`, then manual checks in the Extension Development Host. Do not add a test framework
unless explicitly requested.

## Architecture notes and conventions

### Webview message contract

Extension host and webview communicate over `postMessage`. Keep these in sync between
`src/webviewPanel.ts` (`SeekyWebviewController.handleMessage`) and `media/main.js`:

- Webview → host: `search` (`{query, mode, grepMode}`), `preview` (`{item}`), `open`
  (`{item, sideBySide?, dispose?}`), `close`
- Host → webview: `results` (`{items, done, capped, duration}`), `preview`, `setMode`,
  `setQuery`, `focus`

Shared result shapes (`FFSearchResult` in `src/searchProvider.ts`): discriminated union of
`grep`, `file`, and `symbol` items. All three render through the same modal pipeline.

### Search modes

Modes (`SearchMode` in `src/webviewPanel.ts`, mirrored in `SeekySearchOptions` enum):
`grep`, `files`, `git-modified`, `recent`, `buffers`, `symbols`, `workspace-symbols`.
Grep supports three sub-modes — `fuzzy` (default), `plain`, `regex` — selected with `\f`,
`\p`, `\r` query prefixes (parsed identically in `media/main.js` and
`src/commands/modalGrep.ts`). Adding a new mode means touching: `src/webviewPanel.ts`
(`runSearch` branch), `src/searchProvider.ts` (provider function), `media/main.js`
(tab/cycle handling), and possibly `src/types.ts`. See `new-command-instructions.md`.

### fff-node lifecycle

- Reuse the cached finder: `getOrCreateFinder` / `destroyFff` in `src/searchProvider.ts`.
  One `FileFinder` per workspace root; it is destroyed and recreated when the root changes.
- Frecency/history LMDB databases live in `<workspace>/.vscode/seeky/` (`frecency.db`,
  `history.db` — git-ignored). Engine logs go to `fff.log` under the extension's
  `globalStorageUri`.
- Search is single-workspace-root (`vscode.workspace.workspaceFolders?.[0]`). Follow that
  assumption unless a feature explicitly adds multi-root support.
- Searches return a cancel function; always cancel the previous search before starting a new
  one, and yield to the macrotask queue before blocking on the native call (existing code
  shows the pattern).
- `trackQuerySelection(query, filePath)` records picks so frecency ranking improves.

### Code style

- TypeScript is **strict**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`.
  Handle optional fields and indexed access explicitly; use `import type` for type-only imports.
- Biome: recommended rules, space indentation, single quotes for JS. Biome ignores `dist`,
  `media/style.css`, `media/codicon.css`. Biome also formats — run `npx biome check --write .`
  only if you intend formatting changes.
- Webview code stays framework-free: direct DOM in `media/main.js`, no frontend framework.
- Result rendering depends on fixed row-height constants in `media/main.js`
  (`HEADER_HEIGHT`, `MATCH_HEIGHT`, `FILE_ITEM_HEIGHT`, `GROUP_GAP`) for virtualization —
  update them when row layouts change.
- ESM-only dependencies: dynamic `import()` with a cached module handle, never top-level
  `require` — see `ESM_IMPORTS.md`. Keep the extension runtime CommonJS.
- Comments and docs are in English. Match the surrounding comment density and naming.

### Working agreements (from `.github/copilot-instructions.md` / `GEMINI.md`)

- Simplicity first: minimum code that solves the problem; no speculative abstractions,
  configurability, or features beyond the request.
- Surgical changes: touch only what the task requires; match existing style; don't refactor
  adjacent code or delete pre-existing dead code (mention it instead). Clean up only orphans
  your own change created.
- Define verifiable success criteria up front and loop until they pass.

## Security considerations

- The webview HTML uses a strict **Content Security Policy** with a per-load nonce
  (`script-src 'nonce-…'`, `default-src 'none'`); `localResourceRoots` is restricted to
  `media/`. New scripts/styles must keep the nonce and CSP intact.
- All file content injected into the webview preview is HTML-escaped (`escapeHtml` in
  `src/searchProvider.ts`); Shiki output is built from tokens, not raw HTML. Preserve this —
  never inject unescaped file content or query strings into the DOM.
- Previews of untrusted workspace files run through the read-only `seeky-preview:` scheme
  for QuickPick flows.
- No secrets are stored by the extension; state is limited to VS Code `workspaceState`/
  `globalState` (MRU list, search history, sidebar mode/query) and the local LMDB databases.
- CI publishes to the Marketplace via an Azure DevOps service connection
  (`SeekyDevOps`) using `vsce publish --azure-credential` — no PAT in the repo. Do not add
  credentials to the pipeline files.

## CI / deployment

`azure-pipelines.yml` (Azure DevOps, triggers on `main`/`master`):

1. **Build job** (matrix: `windows-latest` / `ubuntu-latest`): `npm ci` → `npm run compile`
   → `npx vsce package --target <win32-x64|linux-x64>` → publishes `.vsix` build artifacts.
2. **Publish job** (main/master only): downloads artifacts and publishes both packages to
   the VS Code Marketplace via `AzureCLI@2` + `vsce publish --azure-credential`.

`azcli_managed.yaml` is a small helper pipeline that inspects the managed identity behind
the `SeekyDevOps` service connection. The extension is not yet on the Marketplace as a
stable release; local install is via `npm run package` → `seeky-<version>.vsix`.

## Gotchas

- `README.md` is outdated (describes rg/fzf/QuickPick architecture); trust the code and this
  file. The contributed configuration settings in `package.json` are only `seeky.maxResults`
  and `seeky.fontFamily` — the README's `seeky.rgPath` etc. do not exist.
- The settings key for max results exists in `package.json`, but `src/searchProvider.ts`
  currently hardcodes `MAX_RESULTS = 100`; check before assuming the setting is honored.
- Windows drive-letter casing is normalized in `getOrCreateFinder` so Neovim and VS Code
  share the same frecency DB namespace — keep that normalization when touching path handling.
- `.vscode/seeky/` contains local runtime databases; never commit them (git-ignored).
