import * as vscode from 'vscode';
import { fuzzyMatchLine } from './matcher';
import { type CurrentTabMatchItem, NO_MATCH_LINE } from '../types';

export function buildCurrentTabItems(editor: vscode.TextEditor, query: string): CurrentTabMatchItem[] {
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

export function getOpenBufferUris(): vscode.Uri[] {
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

export async function buildOpenBufferItems(query: string): Promise<CurrentTabMatchItem[]> {
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
            },
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
            },
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
