import * as vscode from 'vscode';
import {
    searchGrep,
    searchFiles,
    readFilePreview,
} from './searchProvider';
import type { SearchResult } from './searchProvider';

export type SearchMode = 'grep' | 'files' | 'recent' | 'buffers' | 'symbols';
export type GrepMode = 'plain' | 'regex';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export class ModalSearchPanel {
    private static instance: ModalSearchPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private cancelSearch: (() => void) | undefined;
    private readonly workspacePath: string;
    private readonly originViewColumn: vscode.ViewColumn;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        mode: SearchMode,
        initialQuery: string
    ) {
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this.originViewColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        this.panel = vscode.window.createWebviewPanel(
            'seeky',
            'Seeky',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            }
        );
        this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

        const history = this.context.globalState.get<string[]>('searchHistory', []);
        this.panel.webview.html = this.getHtmlContent(mode, initialQuery, history);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
        this.panel.onDidDispose(() => {
            ModalSearchPanel.instance = undefined;
            this.cancelSearch?.();
        });
    }

    private getFontFamily(): string {
        const config = vscode.workspace.getConfiguration('seeky');
        const font = config.get<string>('fontFamily', 'Monaspace Neon');
        if (font === 'System Default') {
            return 'var(--vscode-font-family, system-ui, sans-serif)';
        }
        return `'${font.replace(/\s/g, '')}', var(--vscode-editor-font-family, monospace)`;
    }

    static show(context: vscode.ExtensionContext, mode: SearchMode, initialQuery = ''): void {
        if (ModalSearchPanel.instance) {
            ModalSearchPanel.instance.panel.reveal(vscode.ViewColumn.Active);
            if (initialQuery) {
                ModalSearchPanel.instance.panel.webview.postMessage({ command: 'setQuery', query: initialQuery, mode });
            } else {
                ModalSearchPanel.instance.panel.webview.postMessage({ command: 'setMode', mode });
            }
            // Force focus back to input
            ModalSearchPanel.instance.panel.webview.postMessage({ command: 'focus' });
            return;
        }
        ModalSearchPanel.instance = new ModalSearchPanel(context, mode, initialQuery);
    }

    static dispose(): void {
        ModalSearchPanel.instance?.panel.dispose();
        ModalSearchPanel.instance = undefined;
    }

    private async handleMessage(msg: { command: string;[key: string]: unknown }): Promise<void> {
        switch (msg.command) {
            case 'search':
                this.runSearch(
                    msg['query'] as string,
                    msg['mode'] as SearchMode,
                    (msg['grepMode'] as GrepMode | undefined) ?? 'plain'
                );
                break;
            case 'preview':
                this.sendPreview(msg['item'] as SearchResult);
                break;
            case 'open':
                await this.openItem(
                    msg['item'] as SearchResult,
                    {
                        sideBySide: msg['sideBySide'] as boolean,
                        dispose: msg['dispose'] !== false
                    }
                );
                break;
            case 'close':
                this.panel.dispose();
                break;
        }
    }

    private async runSearch(query: string, mode: SearchMode, grepMode: GrepMode): Promise<void> {
        this.cancelSearch?.();
        this.cancelSearch = undefined;

        if (!query.trim() && mode !== 'recent' && mode !== 'buffers' && mode !== 'symbols') {
            this.panel.webview.postMessage({ command: 'results', items: [], done: true });
            return;
        }

        const start = performance.now();
        const onDone = (cancelled: boolean, duration?: number) => {
            const finalDuration = duration ?? (performance.now() - start);
            this.panel.webview.postMessage({ command: 'results', items, done: true, capped: cancelled, duration: finalDuration });
        };

        const items: SearchResult[] = [];
        const onResult = (item: SearchResult) => items.push(item);

        if (mode === 'grep') {
            this.cancelSearch = searchGrep(query, this.workspacePath, grepMode, onResult, onDone);
        } else if (mode === 'files') {
            this.cancelSearch = searchFiles(query, this.workspacePath, onResult, onDone);
        } else if (mode === 'recent') {
            const mru = this.context.globalState.get<string[]>('mruFiles', []);
            mru.forEach(file => {
                if (file.toLowerCase().includes(query.toLowerCase())) {
                    items.push({ type: 'file', file, relativePath: vscode.workspace.asRelativePath(file) });
                }
            });
            onDone(false);
        } else if (mode === 'buffers') {
            const openFiles = new Set<string>();
            vscode.window.tabGroups.all.forEach(group => {
                group.tabs.forEach(tab => {
                    if (tab.input instanceof vscode.TabInputText) {
                        openFiles.add(tab.input.uri.fsPath);
                    }
                });
            });
            openFiles.forEach(file => {
                if (file.toLowerCase().includes(query.toLowerCase())) {
                    items.push({ type: 'file', file, relativePath: vscode.workspace.asRelativePath(file) });
                }
            });
            onDone(false);
        } else if (mode === 'symbols') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    editor.document.uri
                );
                if (symbols) {
                    const flatten = (s: vscode.DocumentSymbol[], container?: string) => {
                        s.forEach(sym => {
                            if (sym.name.toLowerCase().includes(query.toLowerCase())) {
                                items.push({
                                    type: 'symbol',
                                    file: editor.document.uri.fsPath,
                                    relativePath: vscode.workspace.asRelativePath(editor.document.uri.fsPath),
                                    line: sym.range.start.line + 1,
                                    col: sym.range.start.character + 1,
                                    text: sym.name,
                                    kind: vscode.SymbolKind[sym.kind],
                                    ...(container ? { containerName: container } : {})
                                });
                            }
                            if (sym.children) flatten(sym.children, sym.name);
                        });
                    };
                    flatten(symbols);
                }
            }
            onDone(false);
        }
    }

    private sendPreview(item: SearchResult): void {
        const targetLine = item.type === 'grep' || item.type === 'symbol' ? item.line : 1;
        const targetCol = item.type === 'grep' || item.type === 'symbol' ? item.col : 1;
        const { content, startLine, stats } = readFilePreview(item.file, this.workspacePath, targetLine);
        this.panel.webview.postMessage({
            command: 'preview',
            item: { file: item.file, line: targetLine, col: targetCol },
            content,
            targetLine,
            startLine,
            stats,
        });
    }

    private async openItem(item: SearchResult, options: { sideBySide?: boolean; dispose?: boolean } = {}): Promise<void> {
        const line = item.type === 'grep' ? item.line - 1 : 0;
        const col = item.type === 'grep' ? item.col - 1 : 0;
        const targetColumn = options.sideBySide ? vscode.ViewColumn.Beside : this.originViewColumn;

        if (options.dispose !== false) {
            this.panel.dispose();
        }

        try {
            const doc = await vscode.workspace.openTextDocument(item.file);
            await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                selection: new vscode.Range(line, col, line, col),
                preview: false,
            });
        } catch { }
    }

    private getHtmlContent(mode: SearchMode, _initialQuery: string, _history: string[]): string {
        const nonce = getNonce();
        const webview = this.panel.webview;
        const fontFamily = this.getFontFamily();

        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
        const fontUris = ['argon', 'krypton', 'neon', 'radon', 'xenon'].reduce((acc, v) => {
            acc[v] = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', `monaspace-${v}.woff2`));
            return acc;
        }, {} as Record<string, vscode.Uri>);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${codiconsUri}">
    <link rel="stylesheet" href="${styleUri}">
    <style>
        @font-face { font-family: 'MonaspaceArgon'; src: url('${fontUris['argon']}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceKrypton'; src: url('${fontUris['krypton']}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceNeon'; src: url('${fontUris['neon']}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceRadon'; src: url('${fontUris['radon']}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceXenon'; src: url('${fontUris['xenon']}') format('woff2'); font-weight: 400; }

        html, body {
            height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden;
            background: var(--bg-outer) !important;
        }
    </style>
</head>
<body>
    <div id="telescope-container">
        <!-- Title Bar -->
        <div class="bar bar-divider justify-between">
            <div class="flex items-center gap-2">
                <i class="codicon codicon-telescope text-accent" style="font-size: 14px"></i>
                <span id="title-label" class="font-bold text-primary">Live Grep</span>
            </div>
            <div class="flex items-center gap-4 text-muted">
                <span><kbd class="text-accent bg-transparent">↑↓</kbd> nav</span>
                <span><kbd class="text-accent bg-transparent">↵</kbd> open</span>
                <span><kbd class="text-accent bg-transparent">esc</kbd> close</span>
            </div>
        </div>

        <!-- Search Input -->
        <div id="search-area">
            <span class="text-accent font-bold" style="font-size: 14px">❯</span>
            <input type="text" id="search-input" autocomplete="off" spellcheck="false">
            <span id="result-count" class="text-muted text-[10.5px]"></span>
        </div>

        <!-- Content Area -->
        <div id="content-area">
            <!-- Results List -->
            <div id="results-col">
                <div id="results-list" class="flex-1 overflow-y-auto relative">
                    <div id="results-spacer" style="pointer-events: none;"></div>
                    <div id="results-content" class="w-full" style="position: absolute; top: 0; left: 0; right: 0;"></div>
                </div>
            </div>

            <!-- Preview Pane -->
            <div id="preview-col">
                <div id="preview-header">
                    <span id="preview-filename" class="text-accent font-bold"></span>
                    <span class="text-border-inner mx-2">│</span>
                    <span id="preview-path" class="text-muted truncate"></span>
                </div>
                <div id="preview-content" class="flex-1 overflow-auto p-2">
                    <!-- Preview lines injected here -->
                </div>
            </div>
        </div>

        <!-- Status Bar -->
        <div class="bar bar-divider-top justify-between">
            <span id="status-mode" class="font-bold text-accent">-- INSERT --</span>
            <div class="flex items-center gap-2 text-muted">
                <span>●</span>
                <span id="status-source">workspace</span>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        window.INITIAL_MODE = "${mode}";
        window.INITIAL_QUERY = "${_initialQuery}";
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
