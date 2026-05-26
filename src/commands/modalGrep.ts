import * as vscode from 'vscode';
import { log } from '../logger';
import { searchGrep } from '../searchProvider';
import type { ModalGrepPickItem } from '../types';

function parseModalGrepQuery(rawQuery: string): {
    grepMode: 'plain' | 'regex' | 'fuzzy';
    searchQuery: string;
    waitingForInput: boolean;
} {
    const grepModeByPrefix = {
        f: 'fuzzy',
        p: 'plain',
        r: 'regex',
    } as const;

    const prefixMatch = rawQuery.match(/^\\([fpr])(?:\s+([\s\S]*))?$/);
    if (!prefixMatch) {
        return { grepMode: 'fuzzy', searchQuery: rawQuery, waitingForInput: false };
    }

    const [, prefix, remainder] = prefixMatch;
    const trimmedRemainder = (remainder || '').trim();

    return {
        grepMode: grepModeByPrefix[prefix as keyof typeof grepModeByPrefix] ?? 'fuzzy',
        searchQuery: trimmedRemainder,
        waitingForInput: !trimmedRemainder,
    };
}

export async function showSeekyModalGrepQuickPick(context: vscode.ExtensionContext): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        void vscode.window.showWarningMessage('Seeky: Open a workspace folder first.');
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const selected = activeEditor?.document.getText(activeEditor.selection).trim() ?? '';
    const initialQuery = selected.length >= 3 ? selected : '';
    const currentFile = activeEditor?.document.uri.fsPath;

    const quickPick = vscode.window.createQuickPick<ModalGrepPickItem>();
    (quickPick as vscode.QuickPick<ModalGrepPickItem> & { sortByLabel?: boolean }).sortByLabel = false;
    quickPick.title = 'Seeky: Open Modal Grep';
    quickPick.placeholder = 'Search text... (\\f fuzzy, \\p plain, \\r regex)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = false;
    quickPick.value = initialQuery;

    let cancelSearch: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let requestId = 0;

    const setHint = (label: string, detail?: string): void => {
        const hintItem: ModalGrepPickItem = detail
            ? {
                  label,
                  detail,
                  alwaysShow: true,
              }
            : {
                  label,
                  alwaysShow: true,
              };
        quickPick.items = [hintItem];
        quickPick.activeItems = [];
    };

    const runSearch = (rawQuery: string): void => {
        const token = ++requestId;
        cancelSearch?.();
        cancelSearch = undefined;

        const parsed = parseModalGrepQuery(rawQuery);
        if (parsed.waitingForInput) {
            quickPick.busy = false;
            setHint('Type text after prefix', 'Example: \\r my_regex');
            return;
        }

        const query = parsed.searchQuery.trim();
        if (!query) {
            quickPick.busy = false;
            setHint('Type to grep in workspace', 'Enter opens match, Esc closes');
            return;
        }

        quickPick.busy = true;
        const found: ModalGrepPickItem[] = [];
        cancelSearch = searchGrep(
            query,
            workspacePath,
            parsed.grepMode,
            context.globalStorageUri.fsPath,
            currentFile,
            result => {
                found.push({
                    label: `${result.relativePath}:${result.line}:${result.col}`,
                    description: result.text.trim() || '(blank line)',
                    filePath: result.file,
                    line: result.line,
                    col: result.col,
                    alwaysShow: true,
                });
            },
            cancelled => {
                if (token !== requestId) {
                    return;
                }

                quickPick.busy = false;
                if (cancelled) {
                    return;
                }

                if (found.length === 0) {
                    setHint('No matching lines', 'Try another query or mode');
                    return;
                }

                quickPick.items = found;
                const first = found[0];
                if (first) {
                    quickPick.activeItems = [first];
                }
            },
        );
    };

    quickPick.onDidChangeValue(value => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            runSearch(value);
        }, 75);
    });

    quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (!selectedItem?.filePath) {
            return;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(selectedItem.filePath);
            const line = Math.max(0, (selectedItem.line ?? 1) - 1);
            const col = Math.max(0, (selectedItem.col ?? 1) - 1);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                selection: new vscode.Range(line, col, line, col),
            });
            quickPick.hide();
        } catch (error) {
            log.error('Seeky modal grep failed to open selected match.', error);
            void vscode.window.showErrorMessage('Seeky: Failed to open selected match.');
        }
    });

    quickPick.onDidHide(() => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        cancelSearch?.();
        quickPick.dispose();
    });

    quickPick.show();
    runSearch(initialQuery);
}
