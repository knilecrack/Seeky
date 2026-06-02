import * as vscode from 'vscode';
import { ModalSearchPanel, SeekySidebarViewProvider } from './webviewPanel';
import { destroyFff } from './searchProvider';
import { SeekySearchOptions } from './types';
import {
    runCurrentTabGrepCommand,
    runOpenBuffersFuzzyCommand,
    toggleQuickPickFuzzyScope,
} from './commands/currentTabFuzzy';
import { showSeekyModalQuickPick } from './commands/modalQuickPick';
import { showSeekyModalGrepQuickPick } from './commands/modalGrep';
import { SEEKY_PREVIEW_SCHEME, SeekyPreviewProvider } from './preview/previewProvider';

export function activate(context: vscode.ExtensionContext): void {
    const sidebarProvider = new SeekySidebarViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SeekySidebarViewProvider.viewType, sidebarProvider)
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            SEEKY_PREVIEW_SCHEME,
            new SeekyPreviewProvider(),
        ),
    );

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
        vscode.commands.registerCommand('seeky.openSidebar', () => {
            void sidebarProvider.reveal('grep');
        }),
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

    // Sidebar commands — persistent side panel that stays open after opening results
    context.subscriptions.push(
        vscode.commands.registerCommand('seeky.sidebar.grep', () => {
            void sidebarProvider.reveal('grep');
        }),
        vscode.commands.registerCommand('seeky.sidebar.findFiles', () => {
            void sidebarProvider.reveal('files');
        }),
        vscode.commands.registerCommand('seeky.sidebar.recentFiles', () => {
            void sidebarProvider.reveal('recent');
        }),
        vscode.commands.registerCommand('seeky.sidebar.openBuffers', () => {
            void sidebarProvider.reveal('buffers');
        }),
        vscode.commands.registerCommand('seeky.sidebar.documentSymbols', () => {
            void sidebarProvider.reveal('symbols');
        }),
        vscode.commands.registerCommand('seeky.sidebar.workspaceSymbols', () => {
            void sidebarProvider.reveal('workspace-symbols');
        }),
        vscode.commands.registerCommand('seeky.sidebar.gitModified', () => {
            void sidebarProvider.reveal('git-modified');
        }),
        vscode.commands.registerCommand('seeky.sidebar.searchWordUnderCursor', () => {
            const editor = vscode.window.activeTextEditor;
            const word = editor
                ? editor.document.getText(
                    editor.selection.isEmpty
                        ? editor.document.getWordRangeAtPosition(editor.selection.active)
                        : editor.selection
                ) ?? ''
                : '';
            void sidebarProvider.reveal('grep', word);
        })
    );
}

export function deactivate(): void {
    ModalSearchPanel.dispose();
    destroyFff();
}
