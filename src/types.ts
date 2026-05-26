import type * as vscode from 'vscode';

export enum SeekySearchOptions {
    Grep = 'grep',
    Files = 'files',
    GitModified = 'git-modified',
    Recent = 'recent',
    Buffers = 'buffers',
    Symbols = 'symbols',
    WorkspaceSymbols = 'workspace-symbols',
}

export interface CurrentTabMatchItem extends vscode.QuickPickItem {
    readonly line: number;
    readonly col: number;
    readonly score?: number;
    readonly matchCols?: readonly number[];
    readonly fileUri: vscode.Uri;
}

export interface ModalFilePickItem extends vscode.QuickPickItem {
    readonly filePath?: string;
}

export interface ModalGrepPickItem extends vscode.QuickPickItem {
    readonly filePath?: string;
    readonly line?: number;
    readonly col?: number;
}

export type FuzzyScope = 'current-buffer' | 'open-buffers';

export const NO_MATCH_LINE = -1;
export const AUTO_PREVIEW_DELAY_MS = 120;
