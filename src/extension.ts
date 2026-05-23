import * as vscode from 'vscode';
import { ModalSearchPanel } from './webviewPanel';
import { destroyFff } from './searchProvider';
import { log } from './logger';


enum SeekySearchOptions {
    Grep = 'grep',
    Files = 'files',
    Recent = 'recent',
    Buffers = 'buffers',
    Symbols = 'symbols',
    WorkspaceSymbols = 'workspace-symbols',
};

interface CurrentTabMatchItem extends vscode.QuickPickItem {
    readonly line: number;
    readonly col: number;
    readonly score?: number;
    readonly matchCols?: readonly number[];
    readonly fileUri: vscode.Uri;
}

const REFRESH_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Refresh results'
};

const CYCLE_SCOPE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync'),
    tooltip: 'Cycle Search Scope'
};

const AUTO_PREVIEW_DELAY_MS = 120;
type FuzzyScope = 'current-buffer' | 'open-buffers';

const NO_MATCH_LINE = -1;
let activeCurrentTabQuickPick: vscode.QuickPick<CurrentTabMatchItem> | undefined;
let toggleActiveFuzzyScope: (() => void) | undefined;

function nextFuzzyScope(scope: FuzzyScope): FuzzyScope {
    switch (scope) {
        case 'current-buffer':
            return 'open-buffers';
        case 'open-buffers':
            return 'current-buffer';
    }
}

function getInitialFuzzyQuery(editor: vscode.TextEditor): string {
    const selected = editor.document.getText(editor.selection).trim();
    return selected.length >= 3 ? selected : '';
}

function fuzzyMatchLine(text: string, query: string): { col: number; score: number; matchCols: number[] } | undefined {
    const caseSensitive = /[A-Z]/.test(query);
    const source = caseSensitive ? text : text.toLowerCase();
    const pattern = caseSensitive ? query : query.toLowerCase();

    let firstMatch = -1;
    let previousIndex = -1;
    let consecutiveMatches = 0;
    const matchCols: number[] = [];

    for (let i = 0; i < pattern.length; i++) {
        const idx = source.indexOf(pattern.charAt(i), previousIndex + 1);
        if (idx === -1) {
            return undefined;
        }

        if (firstMatch === -1) {
            firstMatch = idx;
        }

        if (previousIndex !== -1 && idx === previousIndex + 1) {
            consecutiveMatches += 1;
        }

        previousIndex = idx;
        matchCols.push(idx);
    }

    // Prefer earlier and denser matches so frequently edited symbols bubble up naturally.
    const span = previousIndex - firstMatch + 1;
    const score = 1000 - firstMatch * 5 - span * 2 + consecutiveMatches * 4;
    return { col: firstMatch, score, matchCols };
}

function buildCurrentTabItems(editor: vscode.TextEditor, query: string): CurrentTabMatchItem[] {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return [
            {
                label: 'Enter a query to search',
                description: 'Current tab',
                line: NO_MATCH_LINE,
                col: 0,
                fileUri: editor.document.uri,
            },
        ];
    }

    const items: CurrentTabMatchItem[] = [];
    const maxResults = 200;
    const lineCount = editor.document.lineCount;

    for (let index = 0; index < lineCount; index++) {
        const line = editor.document.lineAt(index);
        const match = fuzzyMatchLine(line.text, trimmedQuery);
        if (!match) {
            continue;
        }

        items.push({
            label: `${index + 1}: ${line.text.trim() || '(blank line)'}`,
            description: vscode.workspace.asRelativePath(editor.document.uri.fsPath),
            detail: `Line ${index + 1}, Column ${match.col + 1}, Score ${match.score}`,
            line: index,
            col: match.col,
            score: match.score,
            matchCols: match.matchCols,
            fileUri: editor.document.uri,
        });
    }

    items.sort((a, b) => {
        const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
        if (scoreDelta !== 0) {
            return scoreDelta;
        }

        return a.line - b.line;
    });

    if (items.length > maxResults) {
        items.length = maxResults;
    }

    if (items.length > 0) {
        return items;
    }

    return [
        {
            label: 'No matches found',
            description: 'Try a different query or refresh after edits',
            line: NO_MATCH_LINE,
            col: 0,
            fileUri: editor.document.uri,
        },
    ];
}

function getOpenBufferUris(): vscode.Uri[] {
    const uris = new Map<string, vscode.Uri>();

    vscode.window.tabGroups.all.forEach(group => {
        group.tabs.forEach(tab => {
            if (tab.input instanceof vscode.TabInputText) {
                uris.set(tab.input.uri.toString(), tab.input.uri);
            }
        });
    });

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && activeUri.scheme === 'file') {
        uris.set(activeUri.toString(), activeUri);
    }

    return Array.from(uris.values());
}

async function buildOpenBufferItems(query: string): Promise<CurrentTabMatchItem[]> {
    const trimmedQuery = query.trim();
    const openUris = getOpenBufferUris();
    if (!openUris.length) {
        return [
            {
                label: 'No open file buffers found',
                description: 'Open files and try again',
                line: NO_MATCH_LINE,
                col: 0,
                fileUri: vscode.Uri.file(''),
            }
        ];
    }

    const fallbackUri = openUris[0];
    if (!fallbackUri) {
        return [
            {
                label: 'No open file buffers found',
                description: 'Open files and try again',
                line: NO_MATCH_LINE,
                col: 0,
                fileUri: vscode.Uri.file(''),
            }
        ];
    }

    if (!trimmedQuery) {
        return [
            {
                label: 'Enter a query to search',
                description: 'Open file buffers',
                line: NO_MATCH_LINE,
                col: 0,
                fileUri: fallbackUri,
            },
        ];
    }

    const items: CurrentTabMatchItem[] = [];
    const maxResults = 200;
    for (const uri of openUris) {
        const doc = await vscode.workspace.openTextDocument(uri);
        for (let index = 0; index < doc.lineCount; index++) {
            const line = doc.lineAt(index);
            const match = fuzzyMatchLine(line.text, trimmedQuery);
            if (!match) {
                continue;
            }

            items.push({
                label: `${index + 1}: ${line.text.trim() || '(blank line)'}`,
                description: vscode.workspace.asRelativePath(doc.uri.fsPath),
                detail: `Line ${index + 1}, Column ${match.col + 1}, Score ${match.score}`,
                line: index,
                col: match.col,
                score: match.score,
                matchCols: match.matchCols,
                fileUri: doc.uri,
            });
        }
    }

    items.sort((a, b) => {
        const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
        if (scoreDelta !== 0) {
            return scoreDelta;
        }

        if (a.fileUri.toString() !== b.fileUri.toString()) {
            return a.fileUri.toString().localeCompare(b.fileUri.toString());
        }

        return a.line - b.line;
    });

    if (items.length > maxResults) {
        items.length = maxResults;
    }

    if (items.length > 0) {
        return items;
    }

    return [
        {
            label: 'No matches found',
            description: 'Try a different query or refresh after edits',
            line: NO_MATCH_LINE,
            col: 0,
            fileUri: fallbackUri,
        },
    ];
}

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
        quickPick.buttons = [
            REFRESH_BUTTON,
            CYCLE_SCOPE_BUTTON,
        ];
    };

    updatePickerChrome();
    quickPick.ignoreFocusOut = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.value = initialQuery;

    const previewDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid var(--vscode-editor-findMatchBorder)'
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

async function runCurrentTabGrepCommand(): Promise<void> {
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

async function runOpenBuffersFuzzyCommand(): Promise<void> {
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

function toggleQuickPickFuzzyScope(): void {
    if (!activeCurrentTabQuickPick || !toggleActiveFuzzyScope) {
        return;
    }

    toggleActiveFuzzyScope();
}

export function activate(context: vscode.ExtensionContext): void {
    // MRU Tracking for Recent Files

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document.uri.scheme === 'file') {
                const fsPath = editor.document.uri.fsPath;
                const currentMru = context.workspaceState.get<string[]>('mruFiles', []);
                const newMru = [fsPath, ...currentMru.filter(p => p !== fsPath)].slice(0, 100);
                context.workspaceState.update('mruFiles', newMru);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('seeky.grep', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Grep);
        }),
        vscode.commands.registerCommand('seeky.findFiles', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Files);
        }),
        vscode.commands.registerCommand('seeky.recentFiles', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Recent);
        }),
        vscode.commands.registerCommand('seeky.openBuffers', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Buffers);
        }),
        vscode.commands.registerCommand('seeky.documentSymbols', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Symbols);
        }),
        vscode.commands.registerCommand('seeky.searchWordUnderCursor', () => {
            const editor = vscode.window.activeTextEditor;
            const word = editor
                ? editor.document.getText(
                    editor.selection.isEmpty
                        ? editor.document.getWordRangeAtPosition(editor.selection.active)
                        : editor.selection
                ) ?? ''
                : '';
            ModalSearchPanel.show(context, SeekySearchOptions.Grep, word);
        }),
        vscode.commands.registerCommand('seeky.grepCurrentTab', () => runCurrentTabGrepCommand()),
        vscode.commands.registerCommand('seeky.fuzzyOpenBuffers', () => runOpenBuffersFuzzyCommand()),
        vscode.commands.registerCommand('seeky.toggleFuzzyScope', () => toggleQuickPickFuzzyScope())
    );
}

export function deactivate(): void {
    ModalSearchPanel.dispose();
    destroyFff();
}
