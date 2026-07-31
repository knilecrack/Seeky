# Seeky

> A Telescope-inspired, keyboard-driven modal search for VS Code — live grep, file finder, buffers, symbols, and more, with real-time previews.

**⚠️ Work in progress.**

---

## What is Seeky?

Seeky brings the Neovim [Telescope](https://github.com/nvim-telescope/telescope.nvim) experience to VS Code: a unified, keyboard-driven picker for files, grep results, buffers, symbols, recent files, and git-modified files — all with live, syntax-highlighted previews.

Search is powered by [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node), the native Rust [`fff`](https://github.com/dmtrKovalenko/fff) engine with Node bindings. There are **no external binaries to install** — no ripgrep, no fzf. Previews are highlighted with [Shiki](https://shiki.style/).

---

## Features

- **Live Grep** — fuzzy, plain-text, or regex search across file contents (`\f` / `\p` / `\r` query prefixes to switch sub-modes)
- **File Finder** — fuzzy file search with frecency-based ranking that learns from your picks
- **Git Modified Files** — jump between files with uncommitted changes
- **Recent Files** — most-recently-used files, tracked per workspace
- **Open Buffers** — switch between open editors
- **Document & Workspace Symbols** — symbol search with kind icons
- **Search Word Under Cursor** — grep seeded with the word at the caret
- **Fast Fuzzy** (QuickPick) — line-level fuzzy search over the current buffer or all open buffers, with auto-preview
- **Real-time previews** — Shiki syntax highlighting; diff previews for git-modified files

### Three UI hosts

The same search UI runs in three places:

1. **Modal** — a floating panel in the editor area; closes after opening a result
2. **Sidebar** — a persistent view in the Seeky activity-bar container; stays open after opening results
3. **Ivy panel** — the same UI in the bottom panel container

---

## Installation

Seeky is not yet published to the VS Code Marketplace. To try it from source:

```sh
git clone https://github.com/knilecrack/Seeky
cd Seeky
npm install
npm run build
```

Then either press `F5` in VS Code to launch the Extension Development Host, or build and install a `.vsix`:

```sh
npm run package
code --install-extension seeky-<version>.vsix
```

---

## Usage

### Default Keybindings

| Keybinding | Action |
|---|---|
| `Ctrl+Shift+G` | Live Grep (modal) |
| `Ctrl+Shift+Alt+P` | Find Files (modal) |
| `Ctrl+Shift+H` | Search Word Under Cursor |
| `Ctrl+Alt+S Ctrl+Alt+G` | Search Git Modified Files |
| `Ctrl+Alt+G` | Sidebar: Live Grep |
| `Ctrl+Alt+P` | Sidebar: Find Files |
| `Ctrl+Alt+H` | Sidebar: Search Word Under Cursor |
| `Alt+Shift+O` | Toggle Fuzzy Scope (in Fast Fuzzy QuickPick) |

On macOS, `Ctrl` becomes `Cmd` (except `Alt+Shift+O`). All bindings are configurable via `keybindings.json`; every command is also available from the Command Palette under the `Seeky` category.

### Inside the Picker

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Open selected item |
| `Tab` / `Shift+Tab` | Cycle search modes (grep, files, git-modified, recent, buffers, symbols) |
| `Esc` `Esc` | Close picker (press twice) |

In Live Grep mode, prefix your query to pick a sub-mode: `\f` fuzzy (default), `\p` plain text, `\r` regex.

---

## Configuration

Settings are available under the `seeky` namespace in `settings.json`:

```jsonc
{
  // Maximum number of search results to display
  "seeky.maxResults": 200,

  // Font used in the Seeky picker (defaults to the editor font)
  "seeky.fontFamily": "Editor Font" // or "Monaspace Argon" | "Krypton" | "Neon" | "Radon" | "Xenon"
}
```

> Note: `seeky.maxResults` is currently registered but the search backend caps results at 100 internally.

---

## Architecture

```
        ┌────────────┬────────────┬────────────┐
        │   Modal    │  Sidebar   │ Ivy panel  │   (shared webview UI)
        └────────────┴─────┬──────┴────────────┘
                           │
                 SeekyWebviewController
                 (messages, dispatch, preview)
                           │
                    searchProvider.ts
                           │
              @ff-labs/fff-node (Rust engine)
        fuzzy files · grep (fuzzy/plain/regex) · frecency
```

- One cached `FileFinder` per workspace root; frecency/history LMDB databases live in `<workspace>/.vscode/seeky/`
- Previews are HTML-escaped and highlighted with Shiki tokens
- See [AGENTS.md](AGENTS.md) for the full architecture guide and contribution conventions

---

## Development

```sh
npm install
npm run build     # Tailwind CSS + esbuild bundle
npm run watch     # rebuild on change
npm run compile   # type-check only
npm run lint      # Biome
```

There is no automated test suite yet — verify changes with `compile` + `lint` + `build`, then press `F5` and check manually in the Extension Development Host.

---

## Contributing

Feedback, ideas, and PRs are welcome. Please read [AGENTS.md](AGENTS.md) first, and open an issue before sending large PRs so we can align on direction.

---

## License

MIT
