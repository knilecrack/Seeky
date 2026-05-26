import type * as vscode from 'vscode';
import type { FuzzyScope } from '../types';

export function nextFuzzyScope(scope: FuzzyScope): FuzzyScope {
    switch (scope) {
        case 'current-buffer':
            return 'open-buffers';
        case 'open-buffers':
            return 'current-buffer';
    }
}

export function getInitialFuzzyQuery(editor: vscode.TextEditor): string {
    const selected = editor.document.getText(editor.selection).trim();
    return selected.length >= 3 ? selected : '';
}

export function fuzzyMatchLine(
    text: string,
    query: string,
): { col: number; score: number; matchCols: number[] } | undefined {
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
