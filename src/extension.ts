import * as vscode from 'vscode';
import { ModalSearchPanel } from './webviewPanel';
import { destroyFff } from './searchProvider';

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
            ModalSearchPanel.show(context, 'grep');
        }),
        vscode.commands.registerCommand('seeky.findFiles', () => {
            ModalSearchPanel.show(context, 'files');
        }),
        vscode.commands.registerCommand('seeky.recentFiles', () => {
            ModalSearchPanel.show(context, 'recent');
        }),
        vscode.commands.registerCommand('seeky.openBuffers', () => {
            ModalSearchPanel.show(context, 'buffers');
        }),
        vscode.commands.registerCommand('seeky.documentSymbols', () => {
            ModalSearchPanel.show(context, 'symbols');
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
            ModalSearchPanel.show(context, 'grep', word);
        })
    );
}

export function deactivate(): void {
    ModalSearchPanel.dispose();
    destroyFff();
}
