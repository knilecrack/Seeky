import * as vscode from 'vscode';
import { log } from '../logger';
import { searchGrep, trackQuerySelection } from '../searchProvider';
import type { ModalGrepPickItem } from '../types';

type GrepMatch = {
    readonly relativePath: string;
    readonly text: string;
    readonly file: string;
    readonly line: number;
    readonly col: number;
    readonly frecencyScore: number;
};

function buildGroupedItems(matches: readonly GrepMatch[]): ModalGrepPickItem[] {
    // Group matches by file while preserving first-seen order so a stable
    // identity exists for tie-breaking after frecency sort.
    const groups = new Map<string, { firstIndex: number; score: number; matches: GrepMatch[] }>();
    matches.forEach((match, index) => {
        const existing = groups.get(match.relativePath);
        if (existing) {
            existing.matches.push(match);
            if (match.frecencyScore > existing.score) {
                existing.score = match.frecencyScore;
            }
        } else {
            groups.set(match.relativePath, {
                firstIndex: index,
                score: match.frecencyScore,
                matches: [match],
            });
        }
    });

    // Highest frecency first; fall back to original arrival order so non-frecent
    // files retain the engine's relevance ordering.
    const orderedGroups = [...groups.entries()].sort((a, b) => {
        if (b[1].score !== a[1].score) {
            return b[1].score - a[1].score;
        }
        return a[1].firstIndex - b[1].firstIndex;
    });

    const items: ModalGrepPickItem[] = [];
    orderedGroups.forEach(([relativePath, group], groupIndex) => {
        const pathParts = relativePath.replace(/\\/g, '/').split('/');
        const fileName = pathParts[pathParts.length - 1] || relativePath;
        const dirPath = pathParts.slice(0, -1).join('/');

        // Blank separator between groups for breathing room.
        if (groupIndex > 0) {
            items.push({
                label: '',
                kind: vscode.QuickPickItemKind.Separator,
                alwaysShow: true,
            });
        }

        // Bold-style Unicode filename + faint en-dash separator for the folder.
        const boldName = toBoldUnicode(fileName);
        const separatorLabel = dirPath ? `${boldName}   \u2013  ${dirPath}` : boldName;
        items.push({
            label: separatorLabel,
            kind: vscode.QuickPickItemKind.Separator,
            alwaysShow: true,
        });

        for (const match of group.matches) {
            items.push({
                label: `   ${match.line}:${match.col}`,
                description: match.text.trim() || '(blank line)',
                filePath: match.file,
                line: match.line,
                col: match.col,
                alwaysShow: true,
            });
        }
    });

    return items;
}

// Map ASCII letters/digits to their Unicode "mathematical sans-serif bold"
// equivalents so QuickPick renders them visually heavier without needing a
// custom font/theme. Non-ASCII characters pass through unchanged.
function toBoldUnicode(input: string): string {
    let out = '';
    for (const ch of input) {
        const code = ch.codePointAt(0);
        if (code === undefined) {
            out += ch;
            continue;
        }
        if (code >= 0x41 && code <= 0x5a) {
            // A-Z -> 𝗔-𝗭 (U+1D5D4 + offset)
            out += String.fromCodePoint(0x1d5d4 + (code - 0x41));
        } else if (code >= 0x61 && code <= 0x7a) {
            // a-z -> 𝗮-𝘇 (U+1D5EE + offset)
            out += String.fromCodePoint(0x1d5ee + (code - 0x61));
        } else if (code >= 0x30 && code <= 0x39) {
            // 0-9 -> 𝟬-𝟵 (U+1D7EC + offset)
            out += String.fromCodePoint(0x1d7ec + (code - 0x30));
        } else {
            out += ch;
        }
    }
    return out;
}

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
    let lastQuery = '';

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

        lastQuery = query;

        quickPick.busy = true;
        const found: GrepMatch[] = [];
        cancelSearch = searchGrep(
            query,
            workspacePath,
            parsed.grepMode,
            context.globalStorageUri.fsPath,
            currentFile,
            result => {
                found.push({
                    relativePath: result.relativePath,
                    text: result.text,
                    file: result.file,
                    line: result.line,
                    col: result.col,
                    frecencyScore: result.frecencyScore,
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

                const groupedItems = buildGroupedItems(found);
                quickPick.items = groupedItems;
                const firstSelectable = groupedItems.find(item => item.filePath);
                if (firstSelectable) {
                    quickPick.activeItems = [firstSelectable];
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
            trackQuerySelection(lastQuery, selectedItem.filePath);
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
