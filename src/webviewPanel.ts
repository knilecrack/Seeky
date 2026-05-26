import * as vscode from 'vscode';
import type { FFSearchResult } from './searchProvider';
import {
    readFilePreview,
    searchFiles,
    searchGitModifiedFiles,
    searchGrep,
} from './searchProvider';

export type SearchMode = 'grep' | 'files' | 'git-modified' | 'recent' | 'buffers' | 'symbols' | 'workspace-symbols';
export type GrepMode = 'plain' | 'regex' | 'fuzzy';

interface OriginEditorState {
    readonly uri: vscode.Uri;
    readonly viewColumn: vscode.ViewColumn;
    readonly selection: vscode.Selection;
}

interface SeekyIncomingMessage {
    readonly command: string;
    readonly [key: string]: unknown;
}

interface SeekyWebviewControllerOptions {
    readonly context: vscode.ExtensionContext;
    readonly webview: vscode.Webview;
    readonly workspacePath: string;
    readonly getDefaultViewColumn: () => vscode.ViewColumn;
    readonly closeHost: () => void;
    readonly defaultDisposeOnOpen: boolean;
    readonly beforeHostDispose?: () => void;
    readonly onSearchRequest?: (query: string, mode: SearchMode, grepMode: GrepMode) => void;
}

interface OpenItemOptions {
    readonly sideBySide?: boolean;
    readonly dispose?: boolean;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getFontFamily(): string {
    const config = vscode.workspace.getConfiguration('seeky');
    const font = config.get<string>('fontFamily', 'Monaspace Neon');
    if (font === 'System Default') {
        return 'var(--vscode-font-family, system-ui, sans-serif)';
    }

    return `'${font.replace(/\s/g, '')}', var(--vscode-editor-font-family, monospace)`;
}

function getHtmlContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    mode: SearchMode,
    initialQuery: string
): string {
    const nonce = getNonce();
    const fontFamily = getFontFamily();

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'style.css'));
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'codicon.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
    const fontUris = ['argon', 'krypton', 'neon', 'radon', 'xenon'].reduce((acc, v) => {
        acc[v] = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', `monaspace-${v}.woff2`));
        return acc;
    }, {} as Record<string, vscode.Uri>);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
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
            font-family: ${fontFamily};
        }
    </style>
</head>
<body>
    <div id="telescope-container">
        <!-- Top Gradient Accent Line -->
        <div class="window-accent-line"></div>

        <!-- Title Bar -->
        <div class="bar bar-divider justify-between">
            <div class="flex items-center gap-2 h-full">
                <i class="codicon codicon-telescope text-accent" style="font-size: 14px"></i>
                <span id="title-label" style="display: none;">Live Grep</span>
                
                <!-- Modern Sliding Pill Tabs -->
                <div id="mode-tabs-container">
                    <div class="tab-slider"></div>
                    <button class="mode-tab active" data-mode="grep">
                        <i class="codicon codicon-search"></i>
                        <span>Grep</span>
                    </button>
                    <button class="mode-tab" data-mode="files">
                        <i class="codicon codicon-file"></i>
                        <span>Files</span>
                    </button>
                    <button class="mode-tab" data-mode="recent">
                        <i class="codicon codicon-history"></i>
                        <span>Recent</span>
                    </button>
                    <button class="mode-tab" data-mode="buffers">
                        <i class="codicon codicon-layers"></i>
                        <span>Buffers</span>
                    </button>
                    <button class="mode-tab" data-mode="symbols">
                        <i class="codicon codicon-symbol-class"></i>
                        <span>Symbols</span>
                    </button>
                    <button class="mode-tab" data-mode="workspace-symbols">
                        <i class="codicon codicon-globe"></i>
                        <span>W-Symbols</span>
                    </button>
                    <button class="mode-tab" data-mode="git-modified">
                        <i class="codicon codicon-source-control"></i>
                        <span>Git Modified Files</span>
                    </button>
                </div>
            </div>
            <div class="flex items-center gap-4 text-muted">
                <span><kbd class="text-accent bg-transparent">Tab</kbd> mode</span>
                <span><kbd class="text-accent bg-transparent">↑↓</kbd> nav</span>
                <span><kbd class="text-accent bg-transparent">↵</kbd> open</span>
                <span><kbd class="text-accent bg-transparent">esc esc</kbd> close</span>
            </div>
        </div>

        <!-- Search Input -->
        <div id="search-area">
            <span class="text-accent font-bold" style="font-size: 14px">❯</span>
            <input type="text" id="search-input" autocomplete="off" spellcheck="false" placeholder="Search...">
            <div id="regex-toggle" title="Default fuzzy. Prefix with \\f, \\p, or \\r"><i class="codicon codicon-sparkle"></i></div>
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
                    <div class="flex items-center min-w-0">
                        <span id="preview-filename" class="text-accent font-bold"></span>
                        <span class="text-border-inner mx-2">│</span>
                        <span id="preview-path" class="text-muted truncate"></span>
                    </div>
                    <!-- Metadata ribbon for size, date, Git status -->
                    <div id="preview-metadata-ribbon">
                        <span id="badge-git" class="meta-badge hidden"></span>
                        <span id="badge-size" class="meta-badge hidden"></span>
                        <span id="badge-mtime" class="meta-badge hidden"></span>
                    </div>
                </div>
                <div id="preview-content" class="flex-1 overflow-auto p-2 relative">
                    <div id="watermark-preview">
                        <div class="watermark-card">
                            <i class="codicon codicon-telescope"></i>
                            <h2>Seeky Modal Search</h2>
                            <div class="watermark-shortcuts">
                                <span><kbd>Tab</kbd> Cycle Modes</span>
                                <span><kbd>\\f</kbd> fuzzy <kbd>\\p</kbd> plain <kbd>\\r</kbd> regex</span>
                                <span><kbd>↑</kbd> / <kbd>↓</kbd> Navigate</span>
                                <span><kbd>Enter</kbd> Open Result</span>
                            </div>
                        </div>
                    </div>
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
        window.INITIAL_QUERY = "${initialQuery}";
        window.MEDIA_URI = "${webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media'))}";
    </script>
    <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-map.js'))}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

class SeekyWebviewController {
    private cancelSearch: (() => void) | undefined;

    constructor(private readonly options: SeekyWebviewControllerOptions) { }

    dispose(): void {
        this.cancelSearch?.();
        this.cancelSearch = undefined;
    }

    async handleMessage(msg: SeekyIncomingMessage): Promise<void> {
        switch (msg.command) {
            case 'search':
                await this.runSearch(
                    msg['query'] as string,
                    msg['mode'] as SearchMode,
                    (msg['grepMode'] as GrepMode | undefined) ?? 'fuzzy'
                );
                break;
            case 'preview':
                this.sendPreview(msg['item'] as FFSearchResult);
                break;
            case 'open':
                {
                    const parsedOptions: OpenItemOptions = typeof msg['dispose'] === 'boolean'
                        ? {
                            sideBySide: msg['sideBySide'] as boolean,
                            dispose: msg['dispose'] as boolean,
                        }
                        : {
                            sideBySide: msg['sideBySide'] as boolean,
                        };
                await this.openItem(
                    msg['item'] as FFSearchResult,
                    parsedOptions
                );
                }
                break;
            case 'close':
                this.options.closeHost();
                break;
        }
    }

    private async runSearch(query: string, mode: SearchMode, grepMode: GrepMode): Promise<void> {
        this.options.onSearchRequest?.(query, mode, grepMode);

        this.cancelSearch?.();
        this.cancelSearch = undefined;

        if (!query.trim() && mode !== 'recent' && mode !== 'buffers' && mode !== 'symbols' && mode !== 'workspace-symbols' && mode !== 'git-modified') {
            this.options.webview.postMessage({ command: 'results', items: [], done: true });
            return;
        }

        const start = performance.now();
        const onDone = (cancelled: boolean, duration?: number) => {
            if (cancelled) return;
            const finalDuration = duration ?? (performance.now() - start);
            this.options.webview.postMessage({ command: 'results', items, done: true, capped: false, duration: finalDuration });
        };

        const items: FFSearchResult[] = [];
        const onResult = (item: FFSearchResult) => items.push(item);
        const storagePath = this.options.context.globalStorageUri.fsPath;
        const currentFile = vscode.window.activeTextEditor?.document.uri.fsPath;

        if (mode === 'grep') {
            this.cancelSearch = searchGrep(query, this.options.workspacePath, grepMode, storagePath, currentFile, onResult, onDone);
        } else if (mode === 'files') {
            this.cancelSearch = searchFiles(query, this.options.workspacePath, storagePath, currentFile, onResult, onDone);
        } else if (mode === 'git-modified') {
            this.cancelSearch = searchGitModifiedFiles(query, this.options.workspacePath, onResult, onDone);
        } else if (mode === 'recent') {
            const mru = this.options.context.workspaceState.get<string[]>('mruFiles', []);
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
        } else if (mode === 'workspace-symbols') {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                query
            );
            if (symbols) {
                symbols.forEach(sym => {
                    items.push({
                        type: 'symbol',
                        file: sym.location.uri.fsPath,
                        relativePath: vscode.workspace.asRelativePath(sym.location.uri.fsPath),
                        line: sym.location.range.start.line + 1,
                        col: sym.location.range.start.character + 1,
                        text: sym.name,
                        kind: vscode.SymbolKind[sym.kind],
                        ...(sym.containerName ? { containerName: sym.containerName } : {})
                    });
                });
            }
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

    private sendPreview(item: FFSearchResult): void {
        const targetLine = item.type === 'grep' || item.type === 'symbol' ? item.line : 1;
        const targetCol = item.type === 'grep' || item.type === 'symbol' ? item.col : 1;
        const { content, startLine, stats } = readFilePreview(item.file, this.options.workspacePath, targetLine);
        this.options.webview.postMessage({
            command: 'preview',
            item: { file: item.file, line: targetLine, col: targetCol },
            content,
            targetLine,
            startLine,
            stats,
        });
    }

    private async openItem(item: FFSearchResult, options: OpenItemOptions = {}): Promise<void> {
        const line = item.type === 'grep' ? item.line - 1 : 0;
        const col = item.type === 'grep' ? item.col - 1 : 0;
        const targetColumn = options.sideBySide ? vscode.ViewColumn.Beside : this.options.getDefaultViewColumn();
        const shouldDispose = options.dispose ?? this.options.defaultDisposeOnOpen;

        if (shouldDispose) {
            this.options.beforeHostDispose?.();
            this.options.closeHost();
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
}

export class ModalSearchPanel {
    private static instance: ModalSearchPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly controller: SeekyWebviewController;
    private readonly workspacePath: string;
    private readonly originViewColumn: vscode.ViewColumn;
    private readonly originEditor: OriginEditorState | undefined;
    private shouldRestoreOriginEditorFocus = true;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        mode: SearchMode,
        initialQuery: string
    ) {
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const activeEditor = vscode.window.activeTextEditor;
        this.originViewColumn = activeEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.originEditor = activeEditor?.viewColumn
            ? {
                uri: activeEditor.document.uri,
                viewColumn: activeEditor.viewColumn,
                selection: activeEditor.selection,
            }
            : undefined;

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

        this.panel.webview.html = getHtmlContent(this.context, this.panel.webview, mode, initialQuery);
        this.controller = new SeekyWebviewController({
            context: this.context,
            webview: this.panel.webview,
            workspacePath: this.workspacePath,
            getDefaultViewColumn: () => this.originViewColumn,
            closeHost: () => this.panel.dispose(),
            defaultDisposeOnOpen: true,
            beforeHostDispose: () => {
                this.shouldRestoreOriginEditorFocus = false;
            },
            onSearchRequest: (query) => {
                if (!query.trim()) {
                    return;
                }
                const current = this.context.globalState.get<string[]>('searchHistory', []);
                const next = [query, ...current.filter(entry => entry !== query)].slice(0, 50);
                void this.context.globalState.update('searchHistory', next);
            }
        });
        this.panel.webview.onDidReceiveMessage(msg => this.controller.handleMessage(msg as SeekyIncomingMessage));
        this.panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.panel.webview.postMessage({ command: 'focus' });
            }
        });
        this.panel.onDidDispose(() => {
            ModalSearchPanel.instance = undefined;
            this.controller.dispose();
            if (this.shouldRestoreOriginEditorFocus) {
                void this.restoreOriginEditorFocus();
            }
        });
    }

    private async restoreOriginEditorFocus(): Promise<void> {
        if (!this.originEditor) {
            return;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(this.originEditor.uri);
            await vscode.window.showTextDocument(doc, {
                viewColumn: this.originEditor.viewColumn,
                selection: this.originEditor.selection,
                preview: false,
                preserveFocus: false,
            });
        } catch {
            // Ignore focus restoration failures (for example when the document is no longer available).
        }
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
}

export class SeekySidebarViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'seeky.sidebar';

    private static readonly modeStateKey = 'seeky.sidebar.mode';
    private static readonly queryStateKey = 'seeky.sidebar.query';

    private view: vscode.WebviewView | undefined;
    private controller: SeekyWebviewController | undefined;
    private pendingMode: SearchMode | undefined;
    private pendingQuery: string | undefined;

    constructor(private readonly context: vscode.ExtensionContext) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const mode = this.pendingMode ?? this.context.workspaceState.get<SearchMode>(SeekySidebarViewProvider.modeStateKey, 'grep');
        const query = this.pendingQuery ?? this.context.workspaceState.get<string>(SeekySidebarViewProvider.queryStateKey, '');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };

        webviewView.webview.html = getHtmlContent(this.context, webviewView.webview, mode, query);
        
        this.controller?.dispose();

        this.controller = new SeekyWebviewController({
            context: this.context,
            webview: webviewView.webview,
            workspacePath,
            getDefaultViewColumn: () => vscode.ViewColumn.Active,
            closeHost: () => {
                void vscode.commands.executeCommand('workbench.action.closeSidebar');
            },
            defaultDisposeOnOpen: false,
            onSearchRequest: (nextQuery, nextMode) => {
                void this.context.workspaceState.update(SeekySidebarViewProvider.modeStateKey, nextMode);
                void this.context.workspaceState.update(SeekySidebarViewProvider.queryStateKey, nextQuery);
            }
        });

        webviewView.webview.onDidReceiveMessage(msg => this.controller?.handleMessage(msg as SeekyIncomingMessage));
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                webviewView.webview.postMessage({ command: 'focus' });
            }
        });
        webviewView.onDidDispose(() => {
            this.controller?.dispose();
            this.controller = undefined;
            this.view = undefined;
        });

        this.pendingMode = undefined;
        this.pendingQuery = undefined;
    }

    async reveal(mode: SearchMode = 'grep', initialQuery = ''): Promise<void> {
        this.pendingMode = mode;
        this.pendingQuery = initialQuery;

        await vscode.commands.executeCommand('workbench.view.extension.seeky');
        await vscode.commands.executeCommand(`${SeekySidebarViewProvider.viewType}.focus`);

        if (!this.view) {
            return;
        }

        if (initialQuery) {
            this.view.webview.postMessage({ command: 'setQuery', query: initialQuery, mode });
        } else {
            this.view.webview.postMessage({ command: 'setMode', mode });
        }
        this.view.webview.postMessage({ command: 'focus' });
    }
}
