import * as vscode from 'vscode';
import { ModalSearchPanel } from './webviewPanel';
import { destroyFff } from './searchProvider';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('seeky.liveGrep', () => {
            ModalSearchPanel.show(context, 'grep');
        }),
        vscode.commands.registerCommand('seeky.findFiles', () => {
            ModalSearchPanel.show(context, 'files');
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
