import * as vscode from 'vscode';
import { ModalSearchPanel } from './webviewPanel';
import { destroyFff } from './searchProvider';
import { SeekySearchOptions } from './types';
import {
    runCurrentTabGrepCommand,
    runOpenBuffersFuzzyCommand,
    toggleQuickPickFuzzyScope,
} from './commands/currentTabFuzzy';
import { showSeekyModalQuickPick } from './commands/modalQuickPick';
import { showSeekyModalGrepQuickPick } from './commands/modalGrep';

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
        vscode.commands.registerCommand('seeky.openModal', () => {
            void showSeekyModalQuickPick(context);
        }),
        vscode.commands.registerCommand('seeky.openModalGrep', () => {
            void showSeekyModalGrepQuickPick(context);
        }),
        vscode.commands.registerCommand('seeky.grep', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.Grep);
        }),
        vscode.commands.registerCommand('seeky.searchThroughGitModifiedFiles', () => {
            ModalSearchPanel.show(context, SeekySearchOptions.GitModified);
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
