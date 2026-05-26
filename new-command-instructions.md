# Add New Commands in Seeky

This guide explains how to add a new command in this repository.
Each step includes why it is needed.

## 1. Declare the command in the extension manifest

Why this is needed:
VS Code only exposes commands that are declared in the extension manifest.
Without this, the command will not appear in the Command Palette.

Where:
- package.json under contributes.commands

What to add:
- command: unique id, for example seeky.myNewCommand
- title: user-facing label in Command Palette
- category: usually Seeky

Example:

```json
{
  "command": "seeky.myNewCommand",
  "title": "My New Command",
  "category": "Seeky"
}
```

## 2. Add a keybinding (optional but recommended)

Why this is needed:
A keybinding makes the command faster to access and easier to discover.
If you skip this, the command is still available from Command Palette.

Where:
- package.json under contributes.keybindings

What to add:
- command: same id from step 1
- key and mac: shortcut(s)
- when: context guard, for example !terminalFocus

Example:

```json
{
  "command": "seeky.myNewCommand",
  "key": "ctrl+alt+m",
  "mac": "cmd+alt+m",
  "when": "!terminalFocus"
}
```

## 3. Register the command in activate()

Why this is needed:
Manifest declaration alone is metadata.
The command still needs runtime registration so VS Code can execute handler logic.

Where:
- src/extension.ts inside activate(context)

What to add:
- vscode.commands.registerCommand("seeky.myNewCommand", handler)
- include it in context.subscriptions

Example:

```ts
vscode.commands.registerCommand("seeky.myNewCommand", () => {
  ModalSearchPanel.show(context, "files");
});
```

## 4. Wire the command to behavior

Why this is needed:
A registered command must call real behavior, not only open empty UI.
In Seeky, command handlers usually map to a modal mode.

Where (depends on feature):
- src/extension.ts for command routing
- src/webviewPanel.ts for mode handling
- src/searchProvider.ts for data source logic
- media/main.js for webview mode UI and keyboard cycling

What to add for a new search mode:
- Add mode to shared mode type(s)
- Add mode branch in runSearch() in src/webviewPanel.ts
- Add provider function in src/searchProvider.ts
- Add mode label/tab/cycle entry in media/main.js if needed

## 5. Keep the webview message contract aligned

Why this is needed:
Frontend and extension host communicate by message names and payloads.
If fields or command names drift, searches fail silently.

Where:
- src/webviewPanel.ts and media/main.js

Check:
- search message sends expected fields
- results/preview/setMode/setQuery are still handled correctly

## 6. Validate with project checks

Why this is needed:
This repository relies on compile, lint, and build checks to catch regressions.

Run:

```bash
npm run compile
npm run lint
npm run build
```

## 7. Manually verify in Run Extension

Why this is needed:
Some issues only appear at runtime (activation context, UI wiring, keybinding conflicts).

Verify:
- Command appears in Command Palette
- Keybinding triggers expected command
- UI mode loads correctly
- Results, preview, and open behavior are correct

## Quick checklist

1. Command declared in package.json contributes.commands
2. Keybinding added in package.json contributes.keybindings (optional)
3. Command registered in src/extension.ts activate(context)
4. Behavior wired in webviewPanel/searchProvider/main.js as needed
5. Message contract still matches between host and webview
6. compile, lint, and build all pass
7. Manual Run Extension check passes
