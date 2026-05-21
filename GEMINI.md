# Seeky: Modal Search for VS Code

Seeky is a high-performance VS Code extension providing a modal search interface inspired by tools like Telescope and fzf. It offers **Live Grep** and **File Finder** with real-time previews, optimized for speed and a clean aesthetic.

## 🚀 Project Overview

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

- **Purpose**: Fast, modal-driven code and file navigation within VS Code.
- **Key Features**:
  - **Live Grep**: Search through file contents in real-time.
  - **Find Files**: Quickly locate files by name or path.
  - **Real-time Preview**: Instantly view the content of search results without opening the file.
  - **Regex Support**: Toggle between plain text and regular expression search in grep mode.
  - **Word Search**: Search for the word currently under the cursor.
  - **Rosé Pine Theme**: A beautiful, minimalist UI that respects VS Code's light and dark modes.

## 🛠️ Technical Stack

- **Core**: TypeScript (Extension logic & Webview communication).
- **Frontend**: Vanilla JavaScript + Tailwind CSS 4 (Webview UI).
- **Search Engine**: [@ff-labs/fff-node](https://www.npmjs.com/package/@ff-labs/fff-node) (High-performance ripgrep-based search).
- **Styling**: Tailwind CSS 4 with custom Rosé Pine design tokens.
- **Build System**: Custom `esbuild.js` script for bundling and CSS compilation.
- **Fonts & Icons**: Monaspace Neon (font) and @vscode/codicons (icons).

## 🏗️ Architecture

- `src/extension.ts`: Main entry point. Registers commands and handles extension lifecycle.
- `src/webviewPanel.ts`: Manages the VS Code Webview panel, handles bidirectional messaging, and injects the HTML/CSS/JS.
- `src/searchProvider.ts`: Interface for the search engine (`fff-node`). Handles grep, file searching, and preview content extraction.
- `media/`: Static assets for the Webview.
  - `main.js`: Client-side logic for searching, UI updates, and keyboard navigation.
  - `input.css`: Source CSS using Tailwind CSS 4 and theme variables.
  - `style.css`: Compiled CSS output (generated during build).
- `dist/`: Bundled extension output.

## 💻 Development Guide

### Prerequisites

- Node.js
- VS Code

### Key Commands

- **Build**: `npm run build` (Runs esbuild and Tailwind CLI).
- **Watch**: `npm run watch` (Development mode with auto-rebuild and CSS watch).
- **Type Check**: `npm run compile` (Runs `tsc` to verify types without emitting code).

### UI Conventions

- The webview uses a minimalist approach with direct DOM manipulation in `media/main.js` to avoid framework overhead.
- Styling is driven by CSS variables defined in `media/input.css` to support light and dark modes via `.vscode-light` body class.

## ⌨️ Default Keybindings

| Command | Keybinding |
| :--- | :--- |
| **Live Grep** | `Ctrl+Shift+G` (Mac: `Cmd+Shift+G`) |
| **Find Files** | `Ctrl+Shift+Alt+P` (Mac: `Cmd+Shift+Alt+P`) |
| **Search Word Under Cursor** | `Ctrl+Shift+H` (Mac: `Cmd+Shift+H`) |

### In-Modal Shortcuts

- `↑ / ↓`: Navigate results.
- `Enter`: Open selected result in the original editor column.
- `Tab`: Toggle between Grep and Files mode.
- `Alt+R`: Toggle Regex mode (in Grep search).
- `Esc`: Close the search modal.
