# Seeky

> A Telescope-inspired fuzzy finder for VS Code, powered by [`ripgrep`](https://github.com/BurntSushi/ripgrep) and [`fzf`](https://github.com/junegunn/fzf).

**⚠️ Work in progress.** 

---

## What is Seeky?

Seeky brings the Neovim [Telescope](https://github.com/nvim-telescope/telescope.nvim) experience to VS Code — a unified, keyboard-driven fuzzy picker for files, symbols, grep results, buffers, and more. It delegates the heavy lifting to battle-tested CLI tools (`rg` for search, `fzf` for fuzzy matching) and stays out of the way.

---

## Features

| Picker | Command | Description |
|---|---|---|
| Find Files | `seeky.findFiles` | Fuzzy-search all files in the workspace |
| Live Grep | `seeky.liveGrep` | Interactive ripgrep across file contents |
| Buffers | `seeky.buffers` | Switch between open editors |
| Symbols | `seeky.symbols` | Workspace and document symbol search |
| Git Files | `seeky.gitFiles` | Files tracked by Git (`git ls-files`) |
| Find Word Under Cursor | `seeky.findWordUnderCursor` | Live grep seeded with the word at the caret |

---

## Requirements

Seeky shells out to external binaries. Both must be on your `PATH`:

- [`ripgrep`](https://github.com/BurntSushi/ripgrep#installation) (`rg`) — used for file content search
- [`fzf`](https://github.com/junegunn/fzf#installation) — used for fuzzy matching and ranking

**Quick check:**

```sh
rg --version
fzf --version
```

> On Windows, both tools are available via `winget`, `scoop`, or `choco`. On macOS via `brew`. On Linux via your distro's package manager or the project's GitHub releases.

---

## Installation

Seeky is not yet published to the VS Code Marketplace.

To try it from source:

```sh
git clone https://github.com/knilecrack/Seeky
cd Seeky
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

---

## Usage

### Default Keybindings

| Keybinding | Action |
|---|---|
| `Ctrl+P` | Find Files |
| `Ctrl+Shift+F` | Live Grep |
| `Ctrl+Shift+B` | Buffers |
| `Ctrl+Shift+S` | Symbols |
| `Ctrl+Shift+G` | Git Files |
| `Ctrl+Shift+W` | Find Word Under Cursor |

> All bindings are configurable via `keybindings.json`. See [Configuration](#configuration).

### Inside the Picker

| Key | Action |
|---|---|
| `↑` / `↓` or `Ctrl+K` / `Ctrl+J` | Move selection |
| `Enter` | Open selected item |
| `Ctrl+S` | Open in horizontal split |
| `Ctrl+V` | Open in vertical split |
| `Ctrl+T` | Open in new tab |
| `Esc` | Close picker |

---

## Configuration

Settings are available under the `seeky` namespace in your `settings.json`.

```jsonc
{
  // Path overrides if rg/fzf are not on PATH
  "seeky.rgPath": "rg",
  "seeky.fzfPath": "fzf",

  // Extra arguments passed to rg for live grep
  "seeky.rgExtraArgs": ["--hidden", "--glob=!.git"],

  // Extra arguments passed to fzf
  "seeky.fzfExtraArgs": [],

  // Files/dirs to ignore in Find Files (respects .gitignore by default)
  "seeky.fileExcludes": ["**/node_modules/**", "**/.git/**"],

  // Max results returned by any picker
  "seeky.maxResults": 200,

  // Preview pane: show a file preview alongside results
  "seeky.preview.enabled": true
}
```

---

## Architecture

```
VS Code QuickPick UI
        │
        ▼
  Seeky Picker Layer
  (debounce, state, keybindings)
        │
   ┌────┴─────┐
   ▼          ▼
  rg         fzf
(grep/files) (fuzzy rank)
```

Seeky spawns `rg` as a child process to enumerate files or search content, pipes results to `fzf` for fuzzy ranking, and feeds the output back into VS Code's native QuickPick widget. No Electron wrappers, no embedded search engine.

---

## Roadmap

- [ ] Find Files picker
- [ ] Live Grep picker
- [ ] Buffer list picker
- [ ] Workspace & document symbols
- [ ] Git Files picker
- [ ] Find Word Under Cursor
- [ ] File preview pane
- [ ] Multi-select and bulk open
- [ ] Resume last picker state
- [ ] Custom picker API (bring your own source)
- [ ] Marketplace release

---

## Contributing

The project is in early concept stage — feedback, ideas, and PRs are all welcome.

```sh
git clone https://github.com/knilecrack/Seeky
cd Seeky
npm install
```

Run tests:

```sh
npm test
```

Please open an issue before sending large PRs so we can align on direction first.

---

## License

[MIT](LICENSE)
