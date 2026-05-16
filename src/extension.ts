import * as vscode from 'vscode';
import { ModalSearchPanel } from './webviewPanel';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('seeky.liveGrep', () => {
            ModalSearchPanel.show(context, 'grep');
        }),
        vscode.commands.registerCommand('seeky.findFiles', () => {
            ModalSearchPanel.show(context, 'files');
        })
    );
}

export function deactivate(): void {
    ModalSearchPanel.dispose();
}
