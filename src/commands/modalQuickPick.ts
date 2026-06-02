import * as vscode from 'vscode';
import { getInitialFuzzyQuery } from '../fuzzy/matcher';
import { log } from '../logger';
import { searchFiles, trackQuerySelection } from '../searchProvider';
import type { ModalFilePickItem } from '../types';

export async function showSeekyModalQuickPick(context: vscode.ExtensionContext): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        void vscode.window.showWarningMessage('Seeky: Open a workspace folder first.');
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const initialQuery = activeEditor ? getInitialFuzzyQuery(activeEditor) : '';
    const currentFile = activeEditor?.document.uri.fsPath;

    const quickPick = vscode.window.createQuickPick<ModalFilePickItem>();
    (quickPick as vscode.QuickPick<ModalFilePickItem> & { sortByLabel?: boolean }).sortByLabel = false;
    quickPick.title = 'Seeky: Open Modal';
    quickPick.placeholder = 'Search files...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = false;
    quickPick.value = initialQuery;

    let cancelSearch: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let requestId = 0;
    let lastQuery = '';

    const setHint = (label: string, detail?: string): void => {
        const hintItem: ModalFilePickItem = detail
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

    const runSearch = (query: string): void => {
        const token = ++requestId;
        cancelSearch?.();
        cancelSearch = undefined;

        const trimmed = query.trim();
        if (!trimmed) {
            quickPick.busy = false;
            setHint('Type to search files', 'Enter opens file, Esc closes');
            return;
        }

        lastQuery = trimmed;

        quickPick.busy = true;
        const found: ModalFilePickItem[] = [];
        cancelSearch = searchFiles(
            trimmed,
            workspacePath,
            context.globalStorageUri.fsPath,
            currentFile,
            result => {
                found.push({
                    label: result.relativePath,
                    description: result.file,
                    filePath: result.file,
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
                    setHint('No matching files', 'Try another query');
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
        const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0] ?? quickPick.items.find(item => item.filePath);
        if (!selected?.filePath) {
            return;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(selected.filePath);
            await vscode.window.showTextDocument(doc, { preview: false });
            trackQuerySelection(lastQuery, selected.filePath);
            quickPick.hide();
        } catch (error) {
            log.error('Seeky modal failed to open selected file.', error);
            void vscode.window.showErrorMessage('Seeky: Failed to open selected file.');
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
