# Seeky repository instructions

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

When these guidelines conflict, prefer correctness first, then surgical scope, then simplicity, then verification.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertainty blocks a safe change, stop and ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when you can identify a concrete simpler alternative, a correctness issue, or a violated convention.
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

Since there is no committed automated test suite in this repository, verify code changes with `npm run compile`, `npm run lint`, and `npm run build`, then use the Run Extension launch config for manual behavior checks. Do not add a test framework unless explicitly requested.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Build, type-check, and package commands

- `npm run build` bundles the extension with `esbuild`, compiles `media/input.css` to `media/style.css` with Tailwind, and copies Codicons plus Monaspace font assets into `media/`.
- `npm run watch` runs the same pipeline in watch mode for extension development.
- `npm run lint` runs Biome across the repository. To lint one file, run `npx biome lint src/extension.ts`.
- `npm run compile` runs `tsc -p ./ --noEmit`.
- `npm run package` creates a VS Code extension package with `vsce package`.
- `.vscode/launch.json` uses the `Run Extension` launch config with the `npm: build` prelaunch task.
- There is still no committed automated test suite in this repository, so there is no supported single-test command yet.

## High-level architecture

| When editing | Remember |
| --- | --- |
| `src/extension.ts` | Keep it thin: register commands, track recent files in `context.globalState`, and route entry points into the shared `ModalSearchPanel`. |
| `src/webviewPanel.ts` | Own the singleton modal webview, inject the HTML/CSS/JS assets, and translate between VS Code APIs and the webview message protocol. All search modes reuse this same panel. |
| `src/searchProvider.ts` | Treat it as the backend bridge to `@ff-labs/fff-node`: lazily import the ESM package, keep one cached `FileFinder` per workspace, serve grep/file results, and read preview content plus git status metadata. |
| `media/main.js` | Keep the client framework-free: it is a plain JavaScript IIFE with `// @ts-check`, handles keyboard-first navigation, maintains local search history, virtualizes results, and sends `search`, `preview`, and `open` messages. |
| `media/input.css` | Edit this source stylesheet, not `media/style.css`; the build regenerates the output CSS. |

## Key conventions

- Edit `media/input.css`, not `media/style.css`; the build regenerates `style.css`.
- Keep vendor or generated assets out of lint scope. Biome is configured to ignore `dist/**`, `media/style.css`, and `media/codicon.css`.
- Use the fff MCP tools for file search operations when the MCP server is running; otherwise fall back to the workspace search tools.
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
- Ensure that the MCP server is running before executing commands that depend on it.
- The MCP server is integrated with the `@ff-labs/fff-node` package for file search operations.
- Follow the existing conventions for using MCP tools in the repository; see `src/searchProvider.ts` for the canonical usage pattern.
