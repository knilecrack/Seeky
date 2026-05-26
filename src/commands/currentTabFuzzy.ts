import * as vscode from 'vscode';
import { log } from '../logger';
import { AUTO_PREVIEW_DELAY_MS, type CurrentTabMatchItem, type FuzzyScope, NO_MATCH_LINE } from '../types';
import { getInitialFuzzyQuery, nextFuzzyScope } from '../fuzzy/matcher';
import { buildCurrentTabItems, buildOpenBufferItems } from '../fuzzy/itemBuilders';
import { CYCLE_SCOPE_BUTTON, REFRESH_BUTTON } from '../ui/buttons';

let activeCurrentTabQuickPick: vscode.QuickPick<CurrentTabMatchItem> | undefined;
let toggleActiveFuzzyScope: (() => void) | undefined;

async function showCurrentTabGrepPicker(initialQuery: string, scope: FuzzyScope): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Seeky: Open a file to fuzzy-search in the current buffer.');
        return;
    }

    activeCurrentTabQuickPick?.dispose();
    activeCurrentTabQuickPick = undefined;

    const quickPick = vscode.window.createQuickPick<CurrentTabMatchItem>();
    activeCurrentTabQuickPick = quickPick;
    (quickPick as vscode.QuickPick<CurrentTabMatchItem> & { sortByLabel?: boolean }).sortByLabel = false;

    let currentScope: FuzzyScope = scope;

    const toggleScope = () => {
        currentScope = nextFuzzyScope(currentScope);
        clearPreviewDecorations();
        updatePickerChrome();
        void refreshItems();
        scheduleAutoPreview();
    };

    const updatePickerChrome = () => {
        const isCurrentBufferScope = currentScope === 'current-buffer';
        quickPick.title = isCurrentBufferScope
            ? 'Seeky: Fast Fuzzy (Current Buffer)'
            : 'Seeky: Fast Fuzzy (Open Buffers)';
        quickPick.placeholder = isCurrentBufferScope
            ? `Matches in ${vscode.workspace.asRelativePath(editor.document.uri.fsPath)}`
            : 'Matches across open file buffers';
        quickPick.buttons = [REFRESH_BUTTON, CYCLE_SCOPE_BUTTON];
    };

    updatePickerChrome();
    quickPick.ignoreFocusOut = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.value = initialQuery;

    const previewDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid var(--vscode-editor-findMatchBorder)',
    });
    let autoPreviewTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshVersion = 0;
    let lastPreviewEditor: vscode.TextEditor | undefined;

    const clearPreviewTimer = () => {
        if (autoPreviewTimer) {
            clearTimeout(autoPreviewTimer);
            autoPreviewTimer = undefined;
        }
    };

    const clearPreviewDecorations = () => {
        if (lastPreviewEditor) {
            lastPreviewEditor.setDecorations(previewDecoration, []);
            lastPreviewEditor = undefined;
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            activeEditor.setDecorations(previewDecoration, []);
        }
    };

    const jumpToItem = async (item: CurrentTabMatchItem, closeOnJump: boolean): Promise<void> => {
        if (item.line === NO_MATCH_LINE) {
            return;
        }

        const targetDocument = item.fileUri.toString() === editor.document.uri.toString()
            ? editor.document
            : await vscode.workspace.openTextDocument(item.fileUri);

        const targetEditor = await vscode.window.showTextDocument(targetDocument, {
            selection: new vscode.Range(item.line, item.col, item.line, item.col),
            preview: !closeOnJump,
            preserveFocus: !closeOnJump,
        });
        lastPreviewEditor = targetEditor;

        const ranges = item.matchCols?.length
            ? item.matchCols.map(col => new vscode.Range(item.line, col, item.line, col + 1))
            : [new vscode.Range(item.line, item.col, item.line, item.col + 1)];
        targetEditor.setDecorations(previewDecoration, ranges);

        if (closeOnJump) {
            quickPick.hide();
        }
    };

    const scheduleAutoPreview = () => {
        clearPreviewTimer();
        if (!quickPick.value.trim()) {
            clearPreviewDecorations();
            return;
        }

        autoPreviewTimer = setTimeout(async () => {
            const candidate = quickPick.activeItems[0] ?? quickPick.items[0];
            if (!candidate || candidate.line === NO_MATCH_LINE) {
                clearPreviewDecorations();
                return;
            }

            try {
                await jumpToItem(candidate, false);
            } catch (error) {
                log.error('Failed to auto-preview fuzzy match.', error);
            }
        }, AUTO_PREVIEW_DELAY_MS);
    };

    const refreshItems = async () => {
        const currentVersion = ++refreshVersion;
        quickPick.busy = true;
        const items = currentScope === 'current-buffer'
            ? buildCurrentTabItems(editor, quickPick.value)
            : await buildOpenBufferItems(quickPick.value);
        if (currentVersion !== refreshVersion) {
            return;
        }
        quickPick.items = items;
        quickPick.busy = false;
        const firstItem = quickPick.items[0];
        if (firstItem && firstItem.line !== NO_MATCH_LINE) {
            quickPick.activeItems = [firstItem];
        } else {
            quickPick.activeItems = [];
        }
        log.info(`Refreshed ${currentScope} fuzzy results.`);
    };

    await refreshItems();
    toggleActiveFuzzyScope = toggleScope;

    quickPick.onDidTriggerButton(button => {
        if (button === REFRESH_BUTTON) {
            void refreshItems();
            scheduleAutoPreview();
            return;
        }

        if (button === CYCLE_SCOPE_BUTTON) {
            toggleScope();
        }
    });

    quickPick.onDidChangeValue(() => {
        void refreshItems();
        scheduleAutoPreview();
    });

    quickPick.onDidChangeActive(items => {
        const activeItem = items[0];
        if (!activeItem) {
            clearPreviewDecorations();
            return;
        }

        clearPreviewTimer();
        void jumpToItem(activeItem, false).catch(error => {
            log.error('Failed to preview active fuzzy match.', error);
        });
    });

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0] ?? quickPick.items[0];
        if (!selected || selected.line === NO_MATCH_LINE) {
            return;
        }

        try {
            await jumpToItem(selected, true);
        } catch (error) {
            log.error('Failed to open selected current-buffer fuzzy match.', error);
            void vscode.window.showErrorMessage('Seeky: Failed to open the selected match.');
        }
    });

    quickPick.onDidHide(() => {
        clearPreviewTimer();
        clearPreviewDecorations();
        previewDecoration.dispose();
        quickPick.dispose();
        if (activeCurrentTabQuickPick === quickPick) {
            activeCurrentTabQuickPick = undefined;
        }
        if (toggleActiveFuzzyScope === toggleScope) {
            toggleActiveFuzzyScope = undefined;
        }
    });

    quickPick.show();
}

export async function runCurrentTabGrepCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Seeky: Open a file to fuzzy-search in the current buffer.');
        return;
    }

    try {
        const initialQuery = getInitialFuzzyQuery(editor);
        await showCurrentTabGrepPicker(initialQuery, 'current-buffer');
    } catch (error) {
        log.error('Current-buffer fuzzy command failed.', error);
        void vscode.window.showErrorMessage('Seeky: Current buffer fuzzy search failed.');
    }
}

export async function runOpenBuffersFuzzyCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Seeky: Open a file to fuzzy-search in open buffers.');
        return;
    }

    try {
        const initialQuery = getInitialFuzzyQuery(editor);
        await showCurrentTabGrepPicker(initialQuery, 'open-buffers');
    } catch (error) {
        log.error('Open-buffers fuzzy command failed.', error);
        void vscode.window.showErrorMessage('Seeky: Open buffers fuzzy search failed.');
    }
}

export function toggleQuickPickFuzzyScope(): void {
    if (!activeCurrentTabQuickPick || !toggleActiveFuzzyScope) {
        return;
    }

    toggleActiveFuzzyScope();
}
