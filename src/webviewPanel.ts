import * as vscode from 'vscode';
import { log } from './logger';
import type { FFSearchResult } from './searchProvider';
import {
    parseGlobOnlyQuery,
    readGitDiffPreview,
    readFilePreview,
    searchFiles,
    searchGitModifiedFiles,
    searchGlobFiles,
    searchGrep,
    trackQuerySelection,
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
    readonly getSourceUri: () => vscode.Uri | undefined;
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
    const font = config.get<string>('fontFamily', 'Editor Font');
    if (font === 'Editor Font') {
        return 'var(--vscode-editor-font-family, monospace)';
    }

    return `'${font.replace(/\s/g, '')}', var(--vscode-editor-font-family, monospace)`;
}

function getHtmlContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    mode: SearchMode,
    initialQuery: string,
    layout: 'classic' | 'ivy' = 'classic'
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

        /* In-your-face warning when the extension host stops processing messages
           (usually another extension blocking the event loop). Toggled from main.js. */
        #host-busy-banner {
            display: none;
            align-items: center;
            gap: 8px;
            margin: 6px 6px 0 6px;
            padding: 8px 12px;
            border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
            border-radius: 4px;
            background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            color: var(--vscode-errorForeground, #f48771);
            font-weight: 700;
            font-size: 12px;
        }
        #host-busy-banner.visible { display: flex; animation: seeky-busy-pulse 1.2s ease-in-out infinite; }
        @keyframes seeky-busy-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
    </style>
</head>
<body data-layout="${layout}">
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
                <div id="host-busy-banner">
                    <i class="codicon codicon-warning"></i>
                    <span>Extension host busy — another extension is blocking VS Code. Your search is queued and will run when it recovers.</span>
                </div>
                <div id="results-list" class="flex-1 overflow-y-auto relative">
                    <div id="results-content" class="w-full"></div>
                </div>
            </div>

            <!-- Draggable Resizer -->
            <div id="col-resizer"></div>

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
                                <span><kbd>query *.ext</kbd> Filter by File Glob</span>
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
        window.INITIAL_QUERY = "${initialQuery.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
        window.MEDIA_URI = "${webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media'))}";
    </script>
    <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-map.js'))}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

class SeekyWebviewController {
    private cancelSearch: (() => void) | undefined;
    private previewCounter = 0;
    private lastQuery = '';

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
                    (msg['grepMode'] as GrepMode | undefined) ?? 'fuzzy',
                    msg['sentAt'] as number | undefined
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

    private async runSearch(query: string, mode: SearchMode, grepMode: GrepMode, sentAt?: number): Promise<void> {
        this.options.onSearchRequest?.(query, mode, grepMode);
        this.lastQuery = query;

        // The webview timestamps every search; a large gap here means the
        // extension host's event loop was blocked (typically by another
        // extension) and the message sat in the IPC queue.
        if (typeof sentAt === 'number') {
            const queueDelay = Date.now() - sentAt;
            if (queueDelay > 1000) {
                log.warn(`Search message processed ${Math.round(queueDelay)}ms after send — extension host was busy (another extension may be blocking it).`);
            }
        }

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

            // Skip re-sort for grep mode — fff-node's ranking is already optimal there.
            if (query.trim() && items.length > 0 && mode !== 'grep') {
                const lowerQuery = query.toLowerCase();

                // Pre-compute scores into an array to avoid redundant string ops during O(n log n) sort.
                const scores: number[] = [];
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (!item) continue;
                    let score = 0;
                    if (item.type === 'file') {
                        const pathLower = item.relativePath.toLowerCase();
                        const lastSlash = Math.max(pathLower.lastIndexOf('/'), pathLower.lastIndexOf('\\'));
                        const basename = lastSlash >= 0 ? pathLower.slice(lastSlash + 1) : pathLower;

                        if (basename === lowerQuery) score = 100;
                        else if (basename.startsWith(lowerQuery)) score = 90;
                        else if (basename.includes(lowerQuery)) score = 80;
                        else if (pathLower.includes(lowerQuery)) score = 70;
                    } else if (item.type === 'grep' || item.type === 'symbol') {
                        if (item.text.toLowerCase().includes(lowerQuery)) score = 80;
                    }
                    scores[i] = score;
                }

                // Stable sort using pre-computed scores
                const indices = Array.from({ length: items.length }, (_, i) => i);
                indices.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || (a - b));
                const sorted = indices.flatMap(i => items[i] ? [items[i]] : []);
                items.length = 0;
                items.push(...sorted);
            }

            this.options.webview.postMessage({ command: 'results', items, done: true, capped: false, duration: finalDuration });
        };

        const items: FFSearchResult[] = [];
        const onResult = (item: FFSearchResult) => items.push(item);
        const storagePath = this.options.context.globalStorageUri.fsPath;
        const currentFile = vscode.window.activeTextEditor?.document.uri.fsPath;

        if (mode === 'grep') {
            // A query made only of glob tokens (e.g. "*.cs") would match no file
            // content — list the matching files instead. Skipped in regex mode,
            // where '*' is more likely intentional pattern syntax.
            const globPatterns = grepMode === 'regex' ? null : parseGlobOnlyQuery(query);
            if (globPatterns) {
                this.cancelSearch = searchGlobFiles(globPatterns, this.options.workspacePath, storagePath, onResult, onDone);
            } else {
                this.cancelSearch = searchGrep(query, this.options.workspacePath, grepMode, storagePath, currentFile, undefined, onResult, onDone);
            }
        } else if (mode === 'files') {
            this.cancelSearch = searchFiles(query, this.options.workspacePath, storagePath, currentFile, onResult, onDone);
        } else if (mode === 'git-modified') {
            this.cancelSearch = searchGitModifiedFiles(query, this.options.workspacePath, storagePath, onResult, onDone);
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
            // Try VS Code's LSP workspace symbol provider first for accurate kinds.
            try {
                const lspSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                    'vscode.executeWorkspaceSymbolProvider',
                    query
                );
                if (lspSymbols && lspSymbols.length > 0) {
                    const maxResults = vscode.workspace.getConfiguration('seeky').get<number>('maxResults', 200);
                    for (const sym of lspSymbols) {
                        if (items.length >= maxResults) break;
                        const filePath = sym.location.uri.fsPath;
                        items.push({
                            type: 'symbol',
                            file: filePath,
                            relativePath: vscode.workspace.asRelativePath(filePath),
                            line: sym.location.range.start.line + 1,
                            col: sym.location.range.start.character + 1,
                            text: sym.name,
                            kind: vscode.SymbolKind[sym.kind],
                            ...(sym.containerName ? { containerName: sym.containerName } : {})
                        });
                    }
                    onDone(false);
                    return;
                }
            } catch {
                // LSP provider unavailable — fall through to fff-node.
            }
            // Fallback: fff-node definition classifier (grep heuristic).
            this.cancelSearch = searchGrep(query, this.options.workspacePath, grepMode, storagePath, currentFile, { classifyDefinitions: true }, onResult, onDone);
        } else if (mode === 'symbols') {
            const sourceUri = this.options.getSourceUri()
                ?? vscode.window.activeTextEditor?.document.uri;
            if (sourceUri) {
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    sourceUri
                );
                if (symbols) {
                    const sourcePath = sourceUri.fsPath;
                    const flatten = (s: vscode.DocumentSymbol[], container?: string) => {
                        s.forEach(sym => {
                            if (sym.name.toLowerCase().includes(query.toLowerCase())) {
                                items.push({
                                    type: 'symbol',
                                    file: sourcePath,
                                    relativePath: vscode.workspace.asRelativePath(sourcePath),
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

    private async sendPreview(item: FFSearchResult): Promise<void> {
        const targetLine = item.type === 'grep' || item.type === 'symbol' ? item.line : 1;
        const targetCol = item.type === 'grep' || item.type === 'symbol' ? item.col : 1;
        
        // gitStatus exists on all FFSearchResult variants.
        const gitStatus = item.gitStatus;

        const currentCounter = ++this.previewCounter;

        const preview = item.type === 'file' && item.source === 'git-modified'
            ? await readGitDiffPreview(item.file, this.options.workspacePath, gitStatus)
            : await readFilePreview(item.file, targetLine, gitStatus);
            
        if (this.previewCounter !== currentCounter) return;

        this.options.webview.postMessage({
            command: 'preview',
            item: { file: item.file, line: targetLine, col: targetCol },
            content: preview.content,
            targetLine,
            startLine: preview.startLine,
            ...(preview.binary ? { binary: true } : {}),
            stats: preview.stats,
        });
    }

    private async openItem(item: FFSearchResult, options: OpenItemOptions = {}): Promise<void> {
        const line = (item.type === 'grep' || item.type === 'symbol') ? item.line - 1 : 0;
        const col = (item.type === 'grep' || item.type === 'symbol') ? item.col - 1 : 0;
        const targetColumn = options.sideBySide ? vscode.ViewColumn.Beside : this.options.getDefaultViewColumn();
        const shouldDispose = options.dispose ?? this.options.defaultDisposeOnOpen;

        // Train fff's frecency ranking on the pick, same as the QuickPick flows.
        // trackQuerySelection drops empty queries internally.
        trackQuerySelection(this.lastQuery, item.file);

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
            getSourceUri: () => this.originEditor?.uri,
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
            getSourceUri: () => vscode.window.activeTextEditor?.document.uri,
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

export class SeekyIvyViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'seeky.ivy';

    private static readonly modeStateKey = 'seeky.ivy.mode';
    private static readonly queryStateKey = 'seeky.ivy.query';

    private view: vscode.WebviewView | undefined;
    private controller: SeekyWebviewController | undefined;
    private pendingMode: SearchMode | undefined;
    private pendingQuery: string | undefined;

    constructor(private readonly context: vscode.ExtensionContext) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const mode = this.pendingMode ?? this.context.workspaceState.get<SearchMode>(SeekyIvyViewProvider.modeStateKey, 'grep');
        const query = this.pendingQuery ?? this.context.workspaceState.get<string>(SeekyIvyViewProvider.queryStateKey, '');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };

        webviewView.webview.html = getHtmlContent(this.context, webviewView.webview, mode, query, 'ivy');
        
        this.controller?.dispose();

        this.controller = new SeekyWebviewController({
            context: this.context,
            webview: webviewView.webview,
            workspacePath,
            getDefaultViewColumn: () => vscode.ViewColumn.Active,
            getSourceUri: () => vscode.window.activeTextEditor?.document.uri,
            closeHost: () => {
                void vscode.commands.executeCommand('workbench.action.closePanel');
            },
            defaultDisposeOnOpen: false,
            onSearchRequest: (nextQuery, nextMode) => {
                void this.context.workspaceState.update(SeekyIvyViewProvider.modeStateKey, nextMode);
                void this.context.workspaceState.update(SeekyIvyViewProvider.queryStateKey, nextQuery);
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

        await vscode.commands.executeCommand('workbench.view.extension.seeky-panel');
        await vscode.commands.executeCommand(`${SeekyIvyViewProvider.viewType}.focus`);

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
