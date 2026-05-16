import { extname } from 'node:path';
import * as vscode from 'vscode';
import {
    searchGrep,
    searchFiles,
    readFilePreview,
    SearchResult,
    GrepResult,
    FileResult,
    SymbolResult,
} from './searchProvider';

export type SearchMode = 'grep' | 'files' | 'recent' | 'buffers' | 'symbols';
export type GrepMode = 'plain' | 'regex';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
                                    containerName: container
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
        const { content, startLine, stats } = readFilePreview(item.file, this.workspacePath, targetLine);
        this.panel.webview.postMessage({
            command: 'preview',
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
        } catch (err) { }
    }

    private getHtmlContent(mode: SearchMode, initialQuery: string, history: string[]): string {
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
        @font-face { font-family: 'MonaspaceArgon'; src: url('${fontUris.argon}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceKrypton'; src: url('${fontUris.krypton}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceNeon'; src: url('${fontUris.neon}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceRadon'; src: url('${fontUris.radon}') format('woff2'); font-weight: 400; }
        @font-face { font-family: 'MonaspaceXenon'; src: url('${fontUris.xenon}') format('woff2'); font-weight: 400; }

        body { 
            background: var(--rp-base); color: var(--rp-text); 
            font-family: ${fontFamily}; font-size: 13px; 
            padding: 24px; box-sizing: border-box;
        }
        
        .pane {
            position: relative; border: 1px solid var(--rp-hl-med); border-radius: 12px;
            background: rgba(31, 29, 46, 0.5); display: flex; flex-direction: column;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        .pane-label {
            position: absolute; top: -10px; left: 16px; background: var(--rp-base);
            padding: 0 10px; font-size: 10px; font-weight: 800; color: var(--rp-pine);
            z-index: 10; text-transform: uppercase; letter-spacing: 1px; border: 1px solid var(--rp-hl-med); border-radius: 4px;
        }

        #results-pane { flex: 1; min-height: 0; margin-bottom: 24px; }
        #search-pane { height: 72px; }
        #info-pane { height: auto; min-height: 140px; margin-bottom: 24px; }
        #preview-pane { flex: 1; min-height: 0; }

        @media (max-width: 1000px) {
            body { flex-direction: column !important; overflow-y: auto !important; gap: 32px !important; padding: 16px; }
            #left-col, #right-col { flex: none !important; width: 100% !important; height: auto !important; }
            #results-pane { height: 45vh; }
            #preview-pane { height: 55vh; }
            #search-pane { margin-top: 0; }
        }

        .empty-state {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 16px; padding: 80px 20px; color: var(--rp-muted); opacity: 0.5;
        }
        
        #search-input {
            width: 100%; height: 100%; padding: 0 24px;
            background: transparent; border: none; outline: none;
            color: var(--rp-text); font-size: 20px; font-family: inherit;
        }

        kbd {
            background: var(--rp-overlay); color: var(--rp-foam); padding: 2px 5px;
            border-radius: 4px; font-size: 9px; border: 1px solid var(--rp-hl-low);
        }
    </style>
</head>
<body class="h-screen overflow-hidden flex gap-8">
    <div id="left-col" class="flex flex-col flex-[45] min-w-0 h-full">
        <div id="results-pane" class="pane">
            <span class="pane-label" id="results-label">${mode === 'grep' ? 'Live Grep' : 'File Finder'}</span>
            <div id="results-list" class="flex-1 overflow-y-auto relative">
                <div id="results-spacer" style="pointer-events: none;"></div>
                <div id="results-content" class="w-full" style="position: absolute; top: 0; left: 0; right: 0; padding: 12px;"></div>
                <div id="results-empty" class="p-3">
                    <div class="empty-state">
                        <i class="codicon codicon-search" style="font-size:32px"></i>
                        <span>Type to start searching</span>
                    </div>
                </div>
            </div>
        </div>
        
        <div id="search-pane" class="pane shrink-0">
            <span class="pane-label">Prompt</span>
            <div class="flex items-center h-full gap-4 px-4">
                <input
                    type="text" id="search-input"
                    placeholder="${mode === 'grep' ? 'Search code…' : 'Find files…'}"
                    autocomplete="off" spellcheck="false"
                >
                <div id="search-controls" class="flex gap-3 shrink-0 mr-4">
                    <button id="btn-regex" class="segmented-btn px-4 py-2 rounded-lg border btn-inactive" title="Toggle Regex (Alt+R)">
                        <i class="codicon codicon-regex"></i>
                    </button>
                    <span id="result-count" class="text-muted font-mono text-[11px] self-center ml-2 opacity-60"></span>
                </div>
            </div>
        </div>
    </div>

    <div id="right-col" class="flex flex-col flex-[55] min-w-0 h-full">
        <div id="info-pane" class="pane">
            <span class="pane-label">File Details</span>
            <div id="info-content" class="p-5 font-mono text-[11px] leading-relaxed overflow-auto" style="color:var(--rp-subtle)">
                <div class="empty-state">
                    <i class="codicon codicon-info" style="font-size:24px"></i>
                    <span>Select a match to view details</span>
                </div>
            </div>
        </div>

        <div id="preview-pane" class="pane">
            <span class="pane-label" id="preview-label">Preview</span>
            <div id="preview-content" class="flex-1 overflow-auto rounded-b-xl" style="background:var(--rp-base)">
                <div class="empty-state">
                    <i class="codicon codicon-go-to-file" style="font-size:32px"></i>
                    <span>No preview available</span>
                </div>
            </div>
        </div>

        <div id="footer" class="flex gap-5 px-3 py-4 text-[9px] text-muted shrink-0 uppercase tracking-[0.2em] opacity-40">
            <span><kbd>↑↓</kbd> browse</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>⌃↵</kbd> split</span>
            <span><kbd>⌃T</kbd> tab</span>
            <span><kbd>Tab</kbd> mode</span>
            <span><kbd>Alt+R</kbd> regex</span>
            <span><kbd>Esc</kbd> quit</span>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
